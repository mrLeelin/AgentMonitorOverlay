# SPDX-License-Identifier: AGPL-3.0-only
"""Prepare a v1.5.0 overlay without editing or rebuilding the Plane checkout."""
import argparse
import ast
from pathlib import Path
from shutil import copyfile

FILES = {
    "app/views/issue/base.py": "app_issue.py",
    "api/views/issue.py": "api_issue.py",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="Plane Community Edition v1.5.0 checkout")
    parser.add_argument("--output", required=True, type=Path, help="Directory to mount in the Plane API container")
    args = parser.parse_args()
    if '"version": "1.5.0"' not in (args.source / "package.json").read_text(encoding="utf-8"):
        parser.error("This overlay targets Plane Community Edition v1.5.0")
    source = args.source / "apps/api/plane"
    target = args.output
    target.mkdir(parents=True, exist_ok=True)
    # Keep these mounts compatible with existing installations and restore Plane's native handlers.
    generated = {name: (source / relative).read_text(encoding="utf-8") for relative, name in FILES.items()}
    v1 = (source / "api/urls/__init__.py").read_text(encoding="utf-8")
    anchor = "urlpatterns = ["
    if v1.count(anchor) != 1:
        raise SystemExit("Unexpected Plane URL configuration")
    generated["api_urls.py"] = v1.replace(anchor, "from plane.amo_team_board import urlpatterns as studio_patterns\n\nurlpatterns = [\n    *studio_patterns,")
    for filename, content in generated.items():
        ast.parse(content, filename=filename)
        (target / filename).write_text(content, encoding="utf-8")
    for filename in ("amo_team_board.py", "amo_team_workflow.py"):
        copyfile(Path(__file__).with_name(filename), target / filename)


if __name__ == "__main__":
    main()
