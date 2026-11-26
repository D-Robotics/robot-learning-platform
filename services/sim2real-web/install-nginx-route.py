from pathlib import Path
import os
import time


CONFIG = Path(os.environ.get("RDK_SIM2REAL_NGINX_CONFIG", "/etc/nginx/conf.d/rdkstudio-ssl.conf"))
MARKER = "    server_name rdkstudio.d-robotics.cc;\n"
REFERENCE_UPLOAD_ROUTE = """
    location ~ ^/(robotics-learning|sim2real)/api/(v1/duck|sim2real)/(originman-reference/(validate|screen)|runs)/?$ {
        client_max_body_size 16m;
        rewrite ^/(robotics-learning|sim2real)(/.*)$ $2 break;
        proxy_pass http://127.0.0.1:18102;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
"""
CANONICAL_ONLY_UPLOAD_ROUTE = (
    REFERENCE_UPLOAD_ROUTE.replace("^/(robotics-learning|sim2real)/api/", "^/robotics-learning/api/")
    .replace("^/(robotics-learning|sim2real)(/.*)$ $2", "^/robotics-learning(/.*)$ $1")
)
MAIN_LOCATION = "    location /robotics-learning/ {\n"
ROUTE = """
    # BEGIN RDK_SIM2REAL_MANAGED_ROUTE
    location = /robotics-learning { return 301 /robotics-learning/; }
""" + REFERENCE_UPLOAD_ROUTE + """
    location /robotics-learning/ {
        proxy_pass http://127.0.0.1:18102/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 1h;
        client_max_body_size 2m;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "same-origin" always;
    }
    # END RDK_SIM2REAL_MANAGED_ROUTE
"""

REQUIRED_ROUTE_PARTS = (
    "proxy_pass http://127.0.0.1:18102/;",
    "proxy_http_version 1.1;",
    "proxy_set_header X-Forwarded-Proto $scheme;",
    "proxy_buffering off;",
    "proxy_read_timeout 1h;",
    "client_max_body_size 2m;",
)


def route_matches(content: str) -> bool:
    """Return true only when the existing managed route is internally coherent.

    A substring check is not enough: an operator may have a stale location
    pointing at a different port.  In that case the installer must stop and
    ask for a reviewed migration instead of claiming success.
    """
    if content.count(MAIN_LOCATION) != 1:
        return False
    location = content.split(MAIN_LOCATION, 1)[1].split("\n    }", 1)[0]
    return (
        all(part in location for part in REQUIRED_ROUTE_PARTS)
        and "location = /robotics-learning { return 301 /robotics-learning/; }" in content
    )


def target_server_block(content: str) -> str:
    """Extract the configured HTTPS server block, including nested locations."""
    start = content.find(MARKER)
    if start < 0:
        return ""
    depth = 1
    quote = ""
    comment = False
    for index in range(start + len(MARKER), len(content)):
        char = content[index]
        if comment:
            if char == "\n":
                comment = False
            continue
        if quote:
            if char == quote and (index == 0 or content[index - 1] != "\\"):
                quote = ""
            continue
        if char == "#":
            comment = True
        elif char in ("'", '"'):
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return content[start : index + 1]
    return ""


def main() -> None:
    content = CONFIG.read_text()
    if content.count(MARKER) != 1:
        raise SystemExit(f"expected one domain server marker, found {content.count(MARKER)}")
    block = target_server_block(content)
    if not block:
        raise SystemExit("expected rdkstudio HTTPS server block was not found or is unbalanced")
    if MAIN_LOCATION in block:
        if block.count(REFERENCE_UPLOAD_ROUTE) == 1 and CANONICAL_ONLY_UPLOAD_ROUTE not in block:
            print("sim2real reference upload routes already present")
            return
        if block.count(CANONICAL_ONLY_UPLOAD_ROUTE) == 1 and REFERENCE_UPLOAD_ROUTE not in block:
            updated_block = block.replace(CANONICAL_ONLY_UPLOAD_ROUTE, REFERENCE_UPLOAD_ROUTE)
        elif route_matches(block) and "originman-reference/(validate|screen)" not in block:
            updated_block = block.replace(MAIN_LOCATION, REFERENCE_UPLOAD_ROUTE + MAIN_LOCATION)
        else:
            raise SystemExit(
                "an existing /robotics-learning/ route does not match the managed block; "
                "review and migrate it manually"
            )
        updated = content.replace(block, updated_block, 1)
    else:
        updated = content.replace(MARKER, MARKER + ROUTE, 1)
    mode = CONFIG.stat().st_mode & 0o7777
    backup = CONFIG.with_name(f"{CONFIG.name}.bak-sim2real-{time.time_ns()}")
    with backup.open("x", encoding="utf-8") as handle:
        handle.write(content)
    os.chmod(backup, mode)
    temporary = CONFIG.with_name(f".{CONFIG.name}.codex-sim2real.tmp")
    temporary.write_text(updated)
    os.chmod(temporary, mode)
    os.replace(temporary, CONFIG)
    print(f"updated {CONFIG}; backup={backup}")


if __name__ == "__main__":
    main()
