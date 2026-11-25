# SPDX-License-Identifier: AGPL-3.0-only
"""State mapping and permission rules for legacy Studio workflow requests."""

import os

from rest_framework.exceptions import APIException

from plane.db.models import IssueAssignee, State

ALIASES = {
    "pending": ("todo",),
    "doing": ("进行中", "in progress", "doing", "started"),
    "review": ("审查", "待审查", "待审核", "待审阅", "in review", "review", "in-review"),
    "done": ("完成", "已完成", "done", "completed"),
}
GROUPS = {"backlog": "pending", "unstarted": "pending", "started": "doing", "completed": "done"}
TRANSITIONS = {"claim": ("pending", "doing"), "deliver": ("doing", "review"), "accept": ("review", "done"), "return": ("review", "pending"), "withdraw": ("review", "doing")}


class BoardProblem(APIException):
    def __init__(self, code, message):
        self.status_code = code
        super().__init__({"message": message})


def managed(project_id):
    allowed = {item.strip().lower() for item in os.getenv("AMO_PLANE_TEAM_PROJECTS", "").split(",") if item.strip()}
    return "*" in allowed or str(project_id).lower() in allowed


def state_map(project_id):
    result = {}
    states = list(State.objects.filter(project_id=project_id).order_by("sequence"))
    for lane, names in ALIASES.items():
        for name in names:
            match = next((state for state in states if state.name.strip().casefold() == name), None)
            if match:
                result[lane] = match
                break
    # Renamed statuses keep their natural lanes; a review state still needs an explicit name.
    for lane, group in (("doing", "started"), ("done", "completed")):
        if lane not in result:
            options = [state for state in states if state.group == group and state != result.get("review")]
            if options:
                result[lane] = next((state for state in options if state.default), options[0])
    return result


def lane_for(state, mapping):
    if not state:
        return None
    for lane, mapped in mapping.items():
        if state.id == mapped.id:
            return lane
    return GROUPS.get(state.group)


def linked_assignees(issue):
    # Join filtered assignment records, keeping stable order for older multi-assignee Plane issues.
    rows = getattr(issue, "studio_assignees", None)
    if rows is None:
        rows = IssueAssignee.objects.filter(issue=issue).select_related("assignee").order_by("created_at", "id")
    return [row.assignee for row in rows]


def validate_transition(action, issue, user, mapping, assignees):
    lane = lane_for(issue.state, mapping)
    assigned = bool(assignees and assignees[0].id == user.id)
    creator = issue.created_by_id == user.id
    if action == "note":
        if not (assigned or creator):
            raise BoardProblem(403, "只有提出人和执行者可以评论")
        return
    required, _ = TRANSITIONS[action]
    if action == "claim" and issue.state_id != mapping["pending"].id:
        raise BoardProblem(409, "只有 Plane 的 Todo 任务可以在 Studio 领取")
    if lane != required:
        raise BoardProblem(409, "原单状态已变更，请刷新")
    if (action in ("deliver", "withdraw") and not assigned) or (action in ("accept", "return") and not creator):
        raise BoardProblem(403, "当前账号无权进行此操作")
