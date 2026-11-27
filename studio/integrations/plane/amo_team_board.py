# SPDX-License-Identifier: AGPL-3.0-only
"""Studio's work-item API for Plane Community Edition v1.5.0."""

import base64
import binascii
import json
import mimetypes
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from html import escape, unescape
from html.parser import HTMLParser
from pathlib import PurePosixPath
from re import fullmatch, sub
from urllib.parse import quote
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from botocore.exceptions import ClientError
from django.conf import settings
from django.core import signing
from django.core.cache import cache
from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction
from django.db.models import Prefetch, Q
from django.http import StreamingHttpResponse
from django.urls import path
from django.utils import timezone
from django.utils.html import strip_tags
from rest_framework.response import Response

from plane.amo_team_workflow import BoardProblem, TRANSITIONS, lane_for, linked_assignees, managed, state_map, validate_transition
from plane.api.serializers.issue import IssueSerializer
from plane.api.views.base import BaseAPIView
from plane.bgtasks.issue_activities_task import issue_activity
from plane.bgtasks.webhook_task import model_activity
from plane.db.models import (
    APIToken, CycleIssue, FileAsset, Issue, IssueActivity, IssueAssignee, IssueComment, IssueLink, IssueRelation,
    IssueSubscriber, Label, ModuleIssue, Notification, Project, ProjectMember, State, WorkspaceMember,
)
from plane.settings.storage import S3Storage
from plane.utils.host import base_host
from plane.utils.serializers import writable_data

EVENTS = {("pending", "doing"): "claim", ("doing", "review"): "deliver", ("review", "done"): "accept",
          ("review", "pending"): "return", ("review", "doing"): "withdraw", ("doing", "pending"): "release"}
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
MICROSECOND = timedelta(microseconds=1)
FILE_LIMIT = 16 * 1024 * 1024
TOTAL_FILES = 16 * 1024 * 1024
FILE_COUNT = 6
ROLLBACK_SALT = "amo-team-board-release-v1"
ROLLBACK_SECONDS = 120


def scoped_memberships(request):
    memberships = WorkspaceMember.objects.filter(member=request.user, is_active=True).select_related("workspace")
    token_workspace = APIToken.objects.filter(token=request.auth).values_list("workspace_id", flat=True).first()
    return memberships.filter(workspace_id=token_workspace) if token_workspace else memberships


def project_roles(request):
    members = list(scoped_memberships(request))
    roles = {row.project_id: row.role for row in ProjectMember.objects.filter(
        workspace_id__in=[member.workspace_id for member in members], member=request.user, is_active=True,
    )}
    return members, roles


def viewer_name(user):
    return user.display_name or user.first_name or user.username if user else "未知成员"


def revision(issue):
    return (issue.updated_at - EPOCH) // MICROSECOND


def millis(instant):
    return (instant - EPOCH) // timedelta(milliseconds=1)


def lookup_scope(request, slug, project_id):
    workspace = scoped_memberships(request).filter(workspace__slug=slug).first()
    if not workspace:
        raise BoardProblem(404, "此 Plane 工作区不可访问")
    project = Project.objects.filter(pk=project_id, workspace_id=workspace.workspace_id, archived_at__isnull=True).first()
    if not project:
        raise BoardProblem(404, "此 Plane 项目不可访问")
    role = ProjectMember.objects.filter(project=project, member=request.user, is_active=True).values_list("role", flat=True).first()
    if role is None:
        if workspace.role == 20:
            role = 20
        elif workspace.role == 15 and project.network == 2:
            role = 0
        else:
            raise BoardProblem(404, "此 Plane 项目不可访问")
    return project, role


def issues_for(request, project, role, include_archived=False):
    issues = Issue.objects.filter(project=project, is_draft=False)
    if not include_archived:
        issues = issues.filter(archived_at__isnull=True)
    if role == 5 and not project.guest_view_all_features:
        issues = issues.filter(created_by=request.user)
    return issues


def load_issue(request, project, role, ticket_id, lock=False, include_archived=False):
    query = issues_for(request, project, role, include_archived)
    if lock:
        query = query.select_for_update(of=("self",))
    issue = query.select_related("created_by", "state").filter(pk=ticket_id).first()
    if issue is None:
        raise BoardProblem(404, "团队原单不存在或已归档")
    return issue


def summary(issue, mapping):
    assignees = linked_assignees(issue)
    person = assignees[0] if assignees else None
    kind = lane_for(issue.state, mapping)
    if not kind:
        raise BoardProblem(409, "原单的状态不在团队看板中")
    return {
        "id": str(issue.id), "title": issue.name, "creator": viewer_name(issue.created_by),
        "creatorId": str(issue.created_by_id) if issue.created_by_id else None,
        "assignee": viewer_name(person) if person else None, "assigneeId": str(person.id) if person else None,
        "status": kind, "revision": revision(issue), "updatedAt": millis(issue.updated_at),
    }


def assets_for(issue):
    return FileAsset.objects.filter(
        workspace_id=issue.workspace_id, project_id=issue.project_id, issue_id=issue.id, is_uploaded=True,
        is_deleted=False, entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
    )


def describe_asset(asset):
    return {"id": str(asset.id), "name": str(asset.attributes.get("name") or PurePosixPath(asset.asset.name).name), "size": int(asset.size)}


def event(row_id, actor, action, at, text="", files=None):
    return {"id": str(row_id), "actor": viewer_name(actor), "actorId": str(actor.id) if actor else None,
            "action": action, "at": millis(at), "text": text, "files": files or []}


def detail(request, issue, project, mapping):
    files = list(assets_for(issue).order_by("created_at"))
    events = [event(issue.id, issue.created_by, "create", issue.created_at, files=[describe_asset(f) for f in files if not f.comment_id])]
    # Reuse Plane's own timeline and comments. No additional ticket database is needed.
    activities = IssueActivity.objects.filter(issue=issue, field="state").select_related("actor").order_by("-created_at")[:150]
    state_lanes = {
        state.id: lane_for(state, mapping) for state in State.objects.filter(project=project)
    }
    for activity in activities:
        action = EVENTS.get((state_lanes.get(activity.old_identifier), state_lanes.get(activity.new_identifier)))
        if action:
            events.append(event(activity.id, activity.actor, action, activity.created_at))
    comments = IssueComment.objects.filter(issue=issue).select_related("actor").order_by("-created_at")[:150]
    for comment in comments:
        events.append(event(comment.id, comment.actor, "note", comment.created_at, comment.comment_stripped, [describe_asset(f) for f in files if f.comment_id == comment.id]))
    events.sort(key=lambda item: item["at"])
    return {
        **summary(issue, mapping), "description": issue.description_stripped or "", "events": events,
        "intakeTodo": "pending" in mapping and issue.state_id == mapping["pending"].id,
        "webUrl": f"{base_host(request=request, is_app=True).rstrip('/')}/{project.workspace.slug}/browse/{project.identifier}-{issue.sequence_id}/",
    }


def notices_for(request, project, mapping):
    if "review" not in mapping:
        return Notification.objects.none()
    return Notification.objects.filter(
        receiver=request.user, project=project, archived_at__isnull=True,
        data__issue_activity__field="state", data__issue_activity__new_identifier=str(mapping["review"].id),
    ).select_related("triggered_by").order_by("-created_at")


def notice_payload(request, project, mapping, reviews):
    by_ticket = {str(issue.id): issue for issue in reviews if issue.created_by_id == request.user.id}
    notices = {}
    for item in notices_for(request, project, mapping)[:200]:
        key = str(item.entity_identifier)
        issue = by_ticket.get(key)
        if issue and key not in notices:
            notices[key] = {
                "ticketId": key, "title": issue.name, "actor": viewer_name(item.triggered_by),
                "at": millis(item.created_at), "unread": item.read_at is None,
            }
    return list(notices.values())


class CatalogView(BaseAPIView):
    def get(self, request):
        members, roles = project_roles(request)
        result = []
        for member in sorted(members, key=lambda row: row.workspace.name.casefold()):
            available = []
            for project in Project.objects.filter(workspace_id=member.workspace_id, archived_at__isnull=True).order_by("name"):
                project_role = roles.get(project.id)
                if project_role is None and member.role == 20:
                    project_role = 20
                if project_role is None and (member.role != 15 or project.network != 2):
                    continue
                available.append({"id": str(project.id), "name": project.name, "writable": project_role in (15, 20), "missing": []})
            if available:
                result.append({"slug": member.workspace.slug, "name": member.workspace.name, "projects": available})
        return Response({"identity": {"id": str(request.user.id), "name": viewer_name(request.user)}, "workspaces": result})


class SnapshotView(BaseAPIView):
    def get(self, request, slug, project_id):
        project, role = lookup_scope(request, slug, project_id)
        mapping = state_map(project.id)
        writable = role in (15, 20) and managed(project.id) and len(mapping) == 4
        issues = issues_for(request, project, role)
        items = []
        if writable:
            rows = issues.filter(state_id=mapping["pending"].id).select_related("created_by", "state").prefetch_related(
                Prefetch("issue_assignee", queryset=IssueAssignee.objects.select_related("assignee").order_by("created_at", "id"), to_attr="studio_assignees"),
            ).order_by("-updated_at")
            items = [summary(issue, mapping) for issue in rows]
        reviews = issues.filter(state_id=mapping["review"].id, created_by=request.user) if "review" in mapping else []
        return Response({"name": viewer_name(request.user), "viewerId": str(request.user.id), "writable": writable, "intake": "todo", "unclaimProject": project.name,
                         "tickets": items, "notices": notice_payload(request, project, mapping, reviews)})


class LinkedStatusesView(BaseAPIView):
    def post(self, request, slug, project_id):
        project, role = lookup_scope(request, slug, project_id)
        values = request.data.get("ids") if isinstance(request.data, dict) else None
        if not isinstance(values, list) or len(values) > 100 or any(not isinstance(value, str) or len(value) != 36 for value in values):
            raise BoardProblem(400, "原单编号列表无效")
        try:
            ids = [UUID(value) for value in values]
        except ValueError:
            raise BoardProblem(400, "原单编号列表无效") from None
        mapping = state_map(project.id)
        rows = issues_for(request, project, role).filter(id__in=ids).select_related("state").prefetch_related(
            Prefetch("issue_assignee", queryset=IssueAssignee.objects.select_related("assignee").order_by("created_at", "id"), to_attr="studio_assignees"),
        )
        tickets = []
        for issue in rows:
            kind = lane_for(issue.state, mapping)
            if kind:
                assignees = linked_assignees(issue)
                tickets.append({
                    "id": str(issue.id), "status": kind,
                    "intakeTodo": "pending" in mapping and issue.state_id == mapping["pending"].id,
                    "assigneeId": str(assignees[0].id) if assignees else None,
                })
        return Response({"viewerId": str(request.user.id), "tickets": tickets})


class TicketView(BaseAPIView):
    def get(self, request, slug, project_id, ticket_id):
        project, role = lookup_scope(request, slug, project_id)
        return Response(detail(request, load_issue(request, project, role, ticket_id), project, state_map(project.id)))


class ResolveTicketView(BaseAPIView):
    def get(self, request, slug, identifier, number):
        project_id = Project.objects.filter(workspace__slug=slug, identifier__iexact=identifier, archived_at__isnull=True).values_list("id", flat=True).first()
        if not project_id:
            raise BoardProblem(404, "Plane 原单不存在或不可访问")
        project, role = lookup_scope(request, slug, project_id)
        issue = issues_for(request, project, role).filter(sequence_id=number).first()
        if not issue:
            raise BoardProblem(404, "Plane 原单不存在或已归档")
        return Response({"project": str(project.id), "ticketId": str(issue.id)})


class TicketCollectionView(BaseAPIView):
    def post(self, request, slug, project_id):
        project, role = lookup_scope(request, slug, project_id)
        if role not in (15, 20):
            raise BoardProblem(403, "此 Plane 项目暂时无法发布 Studio 团队任务")
        if not isinstance(request.data, dict):
            raise BoardProblem(400, "新建任务格式不正确")
        title, description, request_id = (request.data.get(key) for key in ("title", "description", "requestId"))
        if not isinstance(title, str) or not title.strip() or len(title) > 200 or not isinstance(description, str) or len(description) > 6000:
            raise BoardProblem(400, "请填写任务标题（最多 200 字）和说明（最多 6000 字）")
        if not isinstance(request_id, str) or not fullmatch(r"(?i)[a-f0-9-]{36}", request_id):
            raise BoardProblem(400, "缺少有效的发布编号")
        try:
            request_id = str(UUID(request_id))
        except ValueError:
            raise BoardProblem(400, "缺少有效的发布编号") from None
        issue_id = uuid5(NAMESPACE_URL, f"amo-studio/{project.id}/{request.user.id}/{request_id}")
        state_id = request.data.get("stateId")
        fields = {"name": title.strip(), "description_html": text_html(description.strip())}
        if state_id is not None:
            fields["state"] = state_id
        with transaction.atomic():
            Project.objects.select_for_update(no_key=True).get(pk=project.id)
            issue = Issue._base_manager.filter(pk=issue_id).first()
            if issue:
                if issue.deleted_at or issue.archived_at:
                    raise BoardProblem(409, "这份草稿的原单已经归档或删除")
                return Response(work_item(issue, project))
            serializer = IssueSerializer(data=fields, context={"project_id": project.id, "workspace_id": project.workspace_id, "default_assignee_id": None})
            if not serializer.is_valid():
                raise BoardProblem(400, "Plane 拒绝了工作项内容")
            issue = serializer.save(id=issue_id, created_by=request.user, updated_by=request.user)
            dispatch_activity(request, issue, "issue.activity.created", serializer.data)
            transaction.on_commit(lambda: model_activity.delay(
                model_name="issue", model_id=str(issue.id), requested_data=serializer.data, current_instance=None,
                actor_id=request.user.id, slug=slug, origin=base_host(request=request, is_app=True),
            ), robust=True)
            return Response(work_item(issue, project), status=201)


def text_html(text):
    return "<p>" + escape(text).replace("\n", "<br/>") + "</p>"


def plain_text(html, fallback):
    return unescape(strip_tags(sub(r"(?i)<br\s*/?>|</(?:p|div|li|h[1-6])>", "\n", html or ""))).strip() if html else (fallback or "")


def work_item(issue, project):
    item = {
        "id": str(issue.id), "number": f"{project.identifier}-{issue.sequence_id}", "title": issue.name,
        "stateId": str(issue.state_id) if issue.state_id else None, "priority": issue.priority,
        "assigneeIds": [str(user.id) for user in linked_assignees(issue)],
        "labelIds": sorted(str(label.id) for label in issue.labels.all()),
        "startDate": issue.start_date, "dueDate": issue.target_date,
        "archived": issue.archived_at is not None,
    }
    # Plane's activity worker also touches updated_at. Only editable content and order invalidate a pending edit.
    data = json.dumps([item, issue.description_html, issue.sort_order], cls=DjangoJSONEncoder, sort_keys=True)
    return {**item, "revision": int.from_bytes(sha256(data.encode()).digest()[:6], "big")}


def work_item_detail(request, issue, project, role):
    files = list(assets_for(issue).order_by("created_at"))
    comments = IssueComment.objects.filter(issue=issue).select_related("actor").order_by("created_at", "id")
    return {
        **work_item(issue, project),
        "description": plain_text(issue.description_html, issue.description_stripped), "creator": viewer_name(issue.created_by),
        "creatorAvatarUrl": issue.created_by.avatar_url if issue.created_by_id else None,
        "url": f"{base_host(request=request, is_app=True).rstrip('/')}/{project.workspace.slug}/browse/{project.identifier}-{issue.sequence_id}/",
        "canDelete": role == 20 or (role == 15 and issue.created_by_id == request.user.id),
        "files": [describe_asset(file) for file in files if not file.comment_id],
        "comments": [{
            "id": str(comment.id), "author": viewer_name(comment.actor), "at": millis(comment.created_at),
            "text": plain_text(comment.comment_html, comment.comment_stripped),
            "canEdit": comment.actor_id == request.user.id and role in (15, 20),
            "canDelete": role == 20 or (role == 15 and comment.actor_id == request.user.id),
            "files": [describe_asset(file) for file in files if file.comment_id == comment.id],
        } for comment in comments],
    }


class DescriptionReferences(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.references = []
        self.feed(html or "")

    def handle_starttag(self, tag, attrs):
        if tag in ("a", "img"):
            url = dict(attrs).get("href" if tag == "a" else "src")
            if url and url.startswith(("https://", "http://", "/")):
                self.references.append({"kind": "image" if tag == "img" else "link", "url": url})


def context_assets(issue):
    kind = FileAsset.EntityTypeContext
    return FileAsset.objects.filter(
        workspace_id=issue.workspace_id, project_id=issue.project_id, is_uploaded=True, is_deleted=False,
        comment__deleted_at__isnull=True,
    ).filter(
        Q(issue_id=issue.id, entity_type__in=(kind.ISSUE_ATTACHMENT, kind.ISSUE_DESCRIPTION))
        | Q(comment__issue_id=issue.id, entity_type=kind.COMMENT_DESCRIPTION)
    )


def context_asset(file):
    return {
        **describe_asset(file), "kind": file.entity_type,
        "commentId": str(file.comment_id) if file.comment_id else None,
    }


def context_summary(issue, origin):
    number = f"{issue.project.identifier}-{issue.sequence_id}"
    return {
        "id": str(issue.id), "url": f"{origin}/{issue.project.workspace.slug}/browse/{number}/",
        "number": number, "title": issue.name, "state": issue.state.name if issue.state_id else None,
        "assignees": [viewer_name(user) for user in linked_assignees(issue)],
    }


def context_page(rows, offset, pack, size=15):
    page = list(rows[offset:offset + size + 1])
    return {
        "items": [item for row in page[:size] if (item := pack(row)) is not None],
        "nextOffset": offset + size if len(page) > size else None,
    }


def context_text(text, offset=0, size=8000):
    end = offset + size
    return {"text": text[offset:end], "nextOffset": end if len(text) > end else None}


class WorkItemContextView(BaseAPIView):
    def get(self, request, slug, project_id, ticket_id):
        project, role = lookup_scope(request, slug, project_id)
        issue = load_issue(request, project, role, ticket_id, include_archived=True)
        origin = base_host(request=request, is_app=True).rstrip("/")
        section = request.query_params.get("section")
        raw_offset = request.query_params.get("offset", "0")
        if not fullmatch(r"[0-9]{1,7}", raw_offset) or (section is None and int(raw_offset)):
            raise BoardProblem(400, "无效的分页位置，请使用返回的 nextOffset")
        offset = int(raw_offset)
        scopes = {project.id: issues_for(request, project, role, include_archived=True)}

        def visible_summary(candidate):
            if not candidate:
                return None
            if candidate.project_id not in scopes:
                try:
                    related_project, related_role = lookup_scope(request, slug, candidate.project_id)
                    scopes[candidate.project_id] = issues_for(request, related_project, related_role, include_archived=True)
                except BoardProblem as error:
                    if error.status_code != 404:
                        raise
                    scopes[candidate.project_id] = Issue.objects.none()
            if not scopes[candidate.project_id].filter(pk=candidate.id).exists():
                return None
            return context_summary(candidate, origin)

        def relation(row):
            outgoing = row.issue_id == issue.id
            related = visible_summary(row.related_issue if outgoing else row.issue)
            return {"type": row.relation_type, "direction": "outgoing" if outgoing else "incoming", "item": related} if related else None

        def comments_page():
            rows = IssueComment.objects.filter(issue=issue).select_related("actor").order_by("-created_at", "-id")

            def comment(row):
                text = context_text(plain_text(row.comment_html, row.comment_stripped), size=1800)
                return {
                    "id": str(row.id), "author": viewer_name(row.actor), "at": millis(row.created_at),
                    "editedAt": millis(row.edited_at) if row.edited_at else None,
                    "parentId": str(row.parent_id) if row.parent_id else None,
                    "text": text["text"], "textNextOffset": text["nextOffset"],
                    "references": DescriptionReferences(row.comment_html).references,
                }

            return context_page(rows, offset, comment, size=10)

        sections = {
            "children": lambda: context_page(
                Issue.objects.filter(workspace_id=issue.workspace_id, parent=issue, is_draft=False)
                .select_related("project__workspace", "state").order_by("created_at", "id"), offset, visible_summary,
            ),
            "relations": lambda: context_page(
                IssueRelation.objects.filter(Q(issue=issue) | Q(related_issue=issue))
                .select_related("issue__project__workspace", "issue__state", "related_issue__project__workspace", "related_issue__state")
                .order_by("created_at", "id"), offset, relation,
            ),
            "comments": comments_page,
            "activity": lambda: context_page(
                IssueActivity.objects.filter(issue=issue).select_related("actor").order_by("-created_at", "-id"), offset,
                lambda row: {"id": str(row.id), "actor": viewer_name(row.actor), "at": millis(row.created_at),
                             "verb": row.verb, "field": row.field, "oldValue": row.old_value, "newValue": row.new_value},
            ),
            "files": lambda: context_page(context_assets(issue).order_by("created_at", "id"), offset, context_asset),
            "links": lambda: context_page(
                IssueLink.objects.filter(issue=issue).order_by("created_at", "id"), offset,
                lambda row: {"id": str(row.id), "title": row.title, "url": row.url},
            ),
        }
        result = {"viewerId": str(request.user.id), "readAt": millis(timezone.now()), "item": context_summary(issue, origin)}
        if section == "description":
            return Response({**result, "description": context_text(plain_text(issue.description_html, issue.description_stripped), offset)})
        if section == "comment":
            try:
                comment_id = UUID(request.query_params.get("commentId", ""))
            except ValueError:
                raise BoardProblem(400, "读取完整评论需要有效的 commentId") from None
            row = IssueComment.objects.filter(issue=issue, id=comment_id).first()
            if not row:
                raise BoardProblem(404, "此工作项下没有这条评论")
            return Response({**result, "comment": {"id": str(row.id), **context_text(plain_text(row.comment_html, row.comment_stripped), offset)}})
        if section is not None:
            if section not in sections:
                raise BoardProblem(400, "未知的 Plane 工作项内容分组")
            return Response({**result, section: sections[section]()})
        description_page = context_text(plain_text(issue.description_html, issue.description_stripped))
        result.update({
            "project": {"id": str(project.id), "name": project.name, "workspace": slug},
            "description": description_page["text"], "descriptionNextOffset": description_page["nextOffset"],
            "descriptionReferences": DescriptionReferences(issue.description_html).references,
            "creator": viewer_name(issue.created_by), "priority": issue.priority,
            "labels": list(issue.labels.order_by("name").values_list("name", flat=True)),
            "type": issue.type.name if issue.type_id else None,
            "estimate": issue.estimate_point.value if issue.estimate_point_id else None,
            "cycles": list(CycleIssue.objects.filter(issue=issue).order_by("cycle__name").values_list("cycle__name", flat=True)),
            "modules": list(ModuleIssue.objects.filter(issue=issue).order_by("module__name").values_list("module__name", flat=True)),
            "startDate": issue.start_date, "dueDate": issue.target_date, "archived": issue.archived_at is not None,
            "createdAt": millis(issue.created_at), "updatedAt": millis(issue.updated_at),
            "completedAt": millis(issue.completed_at) if issue.completed_at else None,
            "parent": visible_summary(issue.parent),
        })
        return Response({**result, **{name: read() for name, read in sections.items()}})


class ProjectWorkItemsView(TicketCollectionView):
    def get(self, request, slug, project_id):
        project, role = lookup_scope(request, slug, project_id)
        states = State.objects.filter(project=project).order_by("sequence", "id")
        members = ProjectMember.objects.filter(project=project, is_active=True, role__gte=15).select_related("member")
        labels = Label.objects.filter(project=project).order_by("name")
        items = issues_for(request, project, role, include_archived=True).prefetch_related(
            "labels",
            Prefetch("issue_assignee", queryset=IssueAssignee.objects.select_related("assignee").order_by("created_at", "id"), to_attr="studio_assignees"),
        ).order_by("sort_order", "id")
        return Response({
            "name": project.name, "viewerId": str(request.user.id), "writable": role in (15, 20),
            "states": [{"id": str(state.id), "name": state.name, "color": state.color, "group": state.group, "default": state.default} for state in states],
            "members": sorted([{"id": str(row.member_id), "name": viewer_name(row.member)} for row in members], key=lambda row: row["name"].casefold()),
            "labels": [{"id": str(label.id), "name": label.name, "color": label.color} for label in labels],
            "items": [work_item(issue, project) for issue in items],
        })


EDIT_FIELDS = {"title": "name", "stateId": "state", "priority": "priority", "assigneeIds": "assignees",
               "labelIds": "labels", "startDate": "start_date", "dueDate": "target_date"}


def edit_work_item(request, issue, project, fields):
    if not isinstance(fields, dict) or not fields or fields.keys() - (EDIT_FIELDS.keys() | {"description", "beforeId"}):
        raise BoardProblem(400, "工作项修改内容无效")
    data = {target: fields[key] for key, target in EDIT_FIELDS.items() if key in fields}
    if "title" in fields and (not isinstance(fields["title"], str) or not fields["title"].strip() or len(fields["title"]) > 255):
        raise BoardProblem(400, "标题不能为空，最多 255 字")
    if "description" in fields:
        text = fields["description"]
        if not isinstance(text, str) or len(text) > 60000:
            raise BoardProblem(400, "工作项说明最多 60000 字")
        data["description_html"] = text_html(text)
        data["description_binary"] = None
    if "beforeId" in fields or ("state" in data and str(issue.state_id) != data["state"]):
        state_id = data.get("state", issue.state_id)
        if not State.objects.filter(project=project, pk=checked_uuid(state_id)).exists():
            raise BoardProblem(400, "工作项的目标状态不可用")
        neighbors = list(Issue.objects.filter(project=project, state_id=state_id, is_draft=False, archived_at__isnull=True)
                         .exclude(pk=issue.pk).order_by("sort_order", "id").values_list("id", "sort_order"))
        before_id = fields.get("beforeId")
        if before_id is None:
            data["sort_order"] = (neighbors[-1][1] if neighbors else 0) + 10000
        else:
            position = next((i for i, row in enumerate(neighbors) if str(row[0]) == before_id), None)
            if position is None:
                raise BoardProblem(409, "目标位置已经变更，请刷新后重试")
            following = neighbors[position][1]
            preceding = neighbors[position - 1][1] if position else following - 10000
            if following - preceding < 0.01:
                for i, (neighbor_id, _) in enumerate(neighbors):
                    Issue.objects.filter(pk=neighbor_id).update(sort_order=(i + 1) * 10000)
                following, preceding = (position + 1) * 10000, position * 10000
            data["sort_order"] = (preceding + following) / 2
    if "start_date" in data or "target_date" in data:
        data.setdefault("start_date", issue.start_date)
        data.setdefault("target_date", issue.target_date)
    update_issue(request, issue, project, data)


def checked_uuid(value):
    try:
        return UUID(str(value))
    except ValueError:
        raise BoardProblem(400, "工作项参数无效") from None


class ProjectWorkItemView(BaseAPIView):
    def get(self, request, slug, project_id, ticket_id):
        project, role = lookup_scope(request, slug, project_id)
        return Response(work_item_detail(request, load_issue(request, project, role, ticket_id, include_archived=True), project, role))

    @transaction.atomic
    def post(self, request, slug, project_id, ticket_id):
        project, role = lookup_scope(request, slug, project_id)
        if role not in (15, 20):
            raise BoardProblem(403, "你在这个 Plane 项目中没有修改权限")
        if not isinstance(request.data, dict):
            raise BoardProblem(400, "工作项修改内容无效")
        action = request.data.get("action")
        # Serialize card reordering within a project before acquiring row locks.
        fields = request.data.get("fields")
        if action == "edit" and isinstance(fields, dict) and ("stateId" in fields or "beforeId" in fields):
            Project.objects.select_for_update(no_key=True).get(pk=project.id)
        issue = load_issue(request, project, role, ticket_id, lock=True, include_archived=True)
        if action in ("edit", "archive", "restore", "delete") and work_item(issue, project)["revision"] != request.data.get("revision"):
            raise BoardProblem(409, "这张工作项已被修改，请刷新后重试")
        if issue.archived_at and action not in ("restore", "delete"):
            raise BoardProblem(409, "请先恢复这张工作项")
        if action == "bot-comment":
            return result_comment(request, issue)
        if action == "edit":
            edit_work_item(request, issue, project, fields)
        elif action in ("archive", "restore"):
            previous = json.dumps(IssueSerializer(issue).data, cls=DjangoJSONEncoder)
            issue.archived_at = timezone.localdate() if action == "archive" else None
            issue.save(update_fields=["archived_at", "updated_at"])
            dispatch_activity(request, issue, "issue.activity.updated", {"archived_at": issue.archived_at}, previous)
        elif action == "delete":
            if role != 20 and issue.created_by_id != request.user.id:
                raise BoardProblem(403, "只有提出人或项目管理员可以删除这张工作项")
            previous = json.dumps(IssueSerializer(issue).data, cls=DjangoJSONEncoder)
            issue.delete()
            dispatch_activity(request, issue, "issue.activity.deleted", {"issue_id": str(ticket_id)}, previous)
            return Response({"item": None})
        elif action in ("comment", "delete-comment"):
            comment_id = request.data.get("commentId")
            text = request.data.get("text")
            if action == "comment" and (not isinstance(text, str) or not text.strip() or len(text) > 6000):
                raise BoardProblem(400, "请填写评论，最多 6000 字")
            if action == "comment" and comment_id is None:
                note(request, issue, text.strip())
            else:
                comment = IssueComment.objects.filter(issue=issue, pk=checked_uuid(comment_id)).first()
                if not comment:
                    raise BoardProblem(404, "评论已被删除")
                if comment.actor_id != request.user.id and (action == "comment" or role != 20):
                    raise BoardProblem(403, "你没有修改这条评论的权限")
                if action == "delete-comment":
                    comment.delete()
                    dispatch_activity(request, issue, "comment.activity.deleted", {"comment_id": str(comment_id)})
                else:
                    comment.comment_html = text_html(text.strip())
                    comment.comment_stripped = text.strip()
                    comment.save()
                    dispatch_activity(request, issue, "comment.activity.updated", {"id": str(comment.id), "comment_html": comment.comment_html})
        else:
            raise BoardProblem(400, "不支持的工作项操作")
        return Response({"item": work_item_detail(request, issue, project, role)})


def dispatch_activity(request, issue, kind, data, current=None):
    origin = base_host(request=request, is_app=True)
    packed = json.dumps(data, cls=DjangoJSONEncoder)
    actor = str(request.user.id)
    transaction.on_commit(lambda: issue_activity.delay(
        type=kind, requested_data=packed, actor_id=actor, issue_id=str(issue.id), project_id=str(issue.project_id),
        current_instance=current, epoch=int(timezone.now().timestamp()), notification=True, origin=origin,
    ), robust=True)


def update_issue(request, issue, project, data):
    previous = json.dumps(IssueSerializer(issue).data, cls=DjangoJSONEncoder)
    serializer = IssueSerializer(issue, data=data, context={"project_id": project.id, "workspace_id": project.workspace_id}, partial=True)
    if not serializer.is_valid():
        raise BoardProblem(400, "Plane 拒绝了状态或执行者变更")
    serializer.save()
    issue.refresh_from_db()
    accepted = writable_data(serializer, data)
    dispatch_activity(request, issue, "issue.activity.updated", accepted, previous)
    transaction.on_commit(lambda: model_activity.delay(
        model_name="issue", model_id=str(issue.id), requested_data=accepted, current_instance=previous,
        actor_id=request.user.id, slug=project.workspace.slug, origin=base_host(request=request, is_app=True),
    ), robust=True)


def result_comment(request, issue):
    if request.data.get("viewerId") != str(request.user.id):
        raise BoardProblem(409, "Plane 账号已变更，请用接单时的账号回写")
    result_id = request.data.get("resultId")
    text = request.data.get("text")
    if not isinstance(result_id, str) or not fullmatch(r"result-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", result_id):
        raise BoardProblem(400, "验收编号无效")
    if not isinstance(text, str) or not text.strip() or len(text) > 40100:
        raise BoardProblem(400, "交付评论内容无效")
    # ProjectWorkItemView holds the issue row lock through commit, including if the client never sees our response.
    comment = IssueComment.objects.filter(issue=issue, external_source="AMO Studio", external_id=result_id).first()
    if comment is None:
        comment = note(request, issue, text.strip(), result_id=result_id)
    return Response({"id": str(comment.id)})


def note(request, issue, text, *, result_id=None):
    if not text:
        return None
    comment = IssueComment.objects.create(
        project_id=issue.project_id, issue=issue, actor=request.user,
        comment_html=text_html(text),
        comment_stripped=text,
        **({"external_source": "AMO Studio", "external_id": result_id} if result_id else {}),
    )
    dispatch_activity(request, issue, "comment.activity.created", {"id": str(comment.id), "comment_html": comment.comment_html})
    return comment


def decode_files(items):
    if not isinstance(items, list) or len(items) > FILE_COUNT:
        raise BoardProblem(400, "附件数量超出限制")
    result = []
    total = 0
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("base64"), str):
            raise BoardProblem(400, "附件格式无效")
        name = PurePosixPath(item["name"].replace("\\", "/")).name
        if not name or name in (".", "..") or len(name) > 200 or any(ord(ch) < 32 for ch in name):
            raise BoardProblem(400, "附件名称无效")
        try:
            data = base64.b64decode(item["base64"], validate=True)
        except (ValueError, binascii.Error):
            raise BoardProblem(400, "附件格式无效") from None
        total += len(data)
        if len(data) > min(FILE_LIMIT, settings.FILE_SIZE_LIMIT) or total > TOTAL_FILES:
            raise BoardProblem(413, "附件大小超出 Plane 上限")
        result.append((name, data))
    return result


def attach_files(request, issue, files, comment, uploads):
    if not files:
        return
    storage = S3Storage()
    for name, data in files:
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        key = f"{issue.workspace_id}/{uuid4().hex}-{name}"
        storage.s3_client.put_object(Bucket=storage.aws_storage_bucket_name, Key=key, Body=data, ContentType=content_type)
        uploads.append((storage, key))
        asset = FileAsset.objects.create(
            attributes={"name": name, "type": content_type, "size": len(data)}, asset=key, size=len(data),
            workspace_id=issue.workspace_id, project_id=issue.project_id, issue=issue, comment=comment,
            entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT, is_uploaded=True, created_by=request.user,
        )
        dispatch_activity(request, issue, "attachment.activity.created", {"id": str(asset.id), "name": name})


def delete_uploads(uploads):
    for storage, key in uploads:
        try:
            storage.s3_client.delete_object(Bucket=storage.aws_storage_bucket_name, Key=key)
        except ClientError:
            pass


class TicketActionView(BaseAPIView):
    def post(self, request, slug, project_id, ticket_id, action):
        project, role = lookup_scope(request, slug, project_id)
        mapping = state_map(project.id)
        if role not in (15, 20):
            raise BoardProblem(403, "此 Plane 项目对当前账号只读")
        if not managed(project.id) or len(mapping) != 4:
            raise BoardProblem(409, "此项目尚未启用 Studio 团队任务工作流")
        if action not in ("claim", "release", "change") or not isinstance(request.data, dict):
            raise BoardProblem(400, "不支持的团队任务操作")
        uploads = []
        try:
            with transaction.atomic():
                issue = load_issue(request, project, role, ticket_id, lock=True)
                assignees = linked_assignees(issue)
                if action == "release":
                    return self.release(request, issue, project, mapping, assignees)
                claim_key = f"amo-studio-claim:{issue.id}"
                if action == "change" and request.data.get("action") == "unclaim":
                    return self.unclaim(request, issue, project, mapping, assignees)
                if action == "claim" and issue.state_id == mapping["doing"].id and assignees and assignees[0].id == request.user.id:
                    previous = cache.get(claim_key)
                    if isinstance(previous, dict) and previous.get("actor") == str(request.user.id) and previous.get("revision") == request.data.get("revision"):
                        return Response({"ticket": detail(request, issue, project, mapping), "claimId": None})
                if request.data.get("revision") != revision(issue):
                    raise BoardProblem(409, "团队原单已变更，请刷新后重试")
                if action == "claim":
                    validate_transition("claim", issue, request.user, mapping, assignees)
                    previous_state = issue.state_id
                    update_issue(request, issue, project, {"state": str(mapping["doing"].id), "assignees": [str(request.user.id)]})
                    # Plane's activity worker touches updated_at after a write. A per-claim
                    # nonce identifies this transition across those background updates.
                    nonce = uuid4().hex
                    cache.set(claim_key, {"nonce": nonce, "actor": str(request.user.id), "revision": request.data["revision"]}, ROLLBACK_SECONDS)
                    grant = signing.dumps({"ticket": str(issue.id), "actor": str(request.user.id), "nonce": nonce,
                                           "state": str(previous_state), "assignees": [str(person.id) for person in assignees]}, salt=ROLLBACK_SALT)
                    return Response({"ticket": detail(request, issue, project, mapping), "claimId": grant})
                change = request.data.get("action")
                if change not in ("deliver", "accept", "return", "withdraw", "note"):
                    raise BoardProblem(400, "不支持的团队任务操作")
                text = request.data.get("text", "")
                if not isinstance(text, str) or len(text) > 6000:
                    raise BoardProblem(400, "评论最多 6000 字")
                text = text.strip()
                files = decode_files(request.data.get("files", []))
                if change == "note" and not (text or files):
                    raise BoardProblem(400, "请输入评论或选择附件")
                validate_transition(change, issue, request.user, mapping, assignees)
                if change == "deliver" and issue.created_by_id:
                    IssueSubscriber.objects.get_or_create(project=project, issue=issue, subscriber_id=issue.created_by_id)
                if change in TRANSITIONS:
                    update_issue(request, issue, project, {"state": str(mapping[TRANSITIONS[change][1]].id)})
                comment = note(request, issue, text)
                attach_files(request, issue, files, comment, uploads)
                return Response(detail(request, issue, project, mapping))
        except Exception:
            delete_uploads(uploads)
            raise

    def unclaim(self, request, issue, project, mapping, assignees):
        raw_reason = request.data.get("text")
        if not isinstance(raw_reason, str) or not raw_reason.strip() or len(raw_reason) > 6000:
            raise BoardProblem(400, "请填写退回原因（最多 6000 字）")
        reason = raw_reason.strip()
        expected = request.data.get("revision")
        if type(expected) is not int:
            raise BoardProblem(400, "请刷新原单后再退回")
        receipt_key = f"amo-studio-unclaim:{issue.id}:{request.user.id}:{expected}"
        receipt = cache.get(receipt_key)
        if receipt and receipt["reason"] == reason:
            return Response(receipt["ticket"])
        if lane_for(issue.state, mapping) != "doing" and issue.state_id != mapping["pending"].id:
            raise BoardProblem(409, "只有尚未交付的任务可以退回 Todo")
        if not assignees or assignees[0].id != request.user.id:
            raise BoardProblem(403, "只有当前执行者可以退回 Todo")
        if expected != revision(issue):
            raise BoardProblem(409, "团队原单已变更，请刷新后重试")
        if issue.created_by_id:
            IssueSubscriber.objects.get_or_create(project=project, issue=issue, subscriber_id=issue.created_by_id)
        update_issue(request, issue, project, {"state": str(mapping["pending"].id), "assignees": []})
        note(request, issue, "退回 Todo：" + reason)
        ticket = detail(request, issue, project, mapping)
        transaction.on_commit(lambda: cache.set(receipt_key, {"reason": reason, "ticket": ticket}, ROLLBACK_SECONDS), robust=True)
        return Response(ticket)

    def release(self, request, issue, project, mapping, assignees):
        claim_id = request.data.get("claimId")
        if not isinstance(claim_id, str) or len(claim_id) > 2000:
            raise BoardProblem(400, "缺少有效的接单凭据")
        try:
            grant = signing.loads(claim_id, salt=ROLLBACK_SALT, max_age=ROLLBACK_SECONDS)
        except signing.BadSignature:
            raise BoardProblem(409, "这次接单已变更，无法撤回") from None
        key = f"amo-studio-claim:{issue.id}"
        previous = cache.get(key)
        nonce = previous.get("nonce") if isinstance(previous, dict) else previous
        if grant["ticket"] != str(issue.id) or grant["actor"] != str(request.user.id) or not grant.get("nonce") or nonce != grant["nonce"]:
            raise BoardProblem(409, "这次接单已变更，无法撤回")
        if lane_for(issue.state, mapping) != "doing" or not assignees or assignees[0].id != request.user.id:
            raise BoardProblem(409, "这次接单已变更，无法撤回")
        update_issue(request, issue, project, {"state": grant["state"], "assignees": grant["assignees"]})
        cache.delete(key)
        return Response({"ok": True})


class NoticeReadView(BaseAPIView):
    def post(self, request, slug, project_id, ticket_id):
        project, role = lookup_scope(request, slug, project_id)
        issue = load_issue(request, project, role, ticket_id)
        if issue.created_by_id == request.user.id:
            notices_for(request, project, state_map(project.id)).filter(entity_identifier=issue.id, read_at__isnull=True).update(read_at=timezone.now())
        return Response({"ok": True})


class AttachmentView(BaseAPIView):
    context = False

    def get(self, request, slug, project_id, ticket_id, file_id):
        project, role = lookup_scope(request, slug, project_id)
        issue = load_issue(request, project, role, ticket_id, include_archived=True)
        asset = (context_assets(issue) if self.context else assets_for(issue)).filter(pk=file_id).first()
        if not asset:
            raise BoardProblem(404, "附件不存在")
        if asset.size > FILE_LIMIT:
            raise BoardProblem(413, "附件超过 Studio 下载上限")
        storage = S3Storage()
        try:
            result = storage.s3_client.get_object(Bucket=storage.aws_storage_bucket_name, Key=asset.asset.name)
        except ClientError:
            raise BoardProblem(502, "Plane 附件暂时不可下载") from None
        body = result["Body"]
        size = result["ContentLength"]
        if size > FILE_LIMIT:
            body.close()
            raise BoardProblem(413, "附件超过 Studio 下载上限")

        def chunks():
            try:
                yield from body.iter_chunks(chunk_size=65536)
            finally:
                body.close()

        response = StreamingHttpResponse(chunks(), content_type="application/octet-stream")
        response["Content-Length"] = str(size)
        if self.context:
            response["X-Plane-Viewer"] = str(request.user.id)
            response["X-Plane-Filename"] = quote(describe_asset(asset)["name"], safe="")
        return response


ROOT = "amo-team-board/workspaces/<str:slug>/projects/<uuid:project_id>"
urlpatterns = [
    path("amo-team-board/catalog/", CatalogView.as_view()),
    path("amo-team-board/workspaces/<str:slug>/resolve/<str:identifier>/<int:number>", ResolveTicketView.as_view()),
    path(ROOT, SnapshotView.as_view()),
    path(ROOT + "/statuses", LinkedStatusesView.as_view()),
    path(ROOT + "/work-items", ProjectWorkItemsView.as_view()),
    path(ROOT + "/work-items/<uuid:ticket_id>", ProjectWorkItemView.as_view()),
    path(ROOT + "/work-items/<uuid:ticket_id>/context", WorkItemContextView.as_view()),
    path(ROOT + "/work-items/<uuid:ticket_id>/context/files/<uuid:file_id>", AttachmentView.as_view(context=True)),
    path(ROOT + "/tickets", TicketCollectionView.as_view()),
    path(ROOT + "/tickets/<uuid:ticket_id>", TicketView.as_view()),
    path(ROOT + "/tickets/<uuid:ticket_id>/files/<uuid:file_id>", AttachmentView.as_view()),
    path(ROOT + "/tickets/<uuid:ticket_id>/<str:action>", TicketActionView.as_view()),
    path(ROOT + "/notices/<uuid:ticket_id>/read", NoticeReadView.as_view()),
]
