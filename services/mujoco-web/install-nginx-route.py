from pathlib import Path
import os
import re
import time


CONFIG = Path(os.environ.get("RDK_SIM2REAL_NGINX_CONFIG", "/etc/nginx/conf.d/rdkstudio-ssl.conf"))
MARKER = "    server_name rdkstudio.d-robotics.cc;\n"
ROUTE = """
    # BEGIN RDK_MUJOCO_MANAGED_ROUTE
    location = /mujoco { return 301 /mujoco/; }
    location /mujoco/ {
        proxy_pass http://127.0.0.1:18100/;
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
    # END RDK_MUJOCO_MANAGED_ROUTE
"""

# Specific API locations take precedence over the existing /mujoco/ lab
# location. Root paths retain /mujoco/api; the lab's relative ./api and legacy
# /sim2real paths strip their UI prefix. The Node bridge authenticates and
# signs the Python hop, while lab pages and other static routes stay intact.
API_ROUTE = """
    # BEGIN RDK_MUJOCO_AUTHENTICATED_API
    location = /mujoco/api {
        proxy_pass http://127.0.0.1:18102;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 20s;
        client_max_body_size 2m;
    }
    location ^~ /mujoco/api/ {
        proxy_pass http://127.0.0.1:18102;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 20s;
        client_max_body_size 2m;
    }
    location = /mujoco/lab/api {
        proxy_pass http://127.0.0.1:18102/mujoco/api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 20s;
        client_max_body_size 2m;
    }
    location ^~ /mujoco/lab/api/ {
        proxy_pass http://127.0.0.1:18102/mujoco/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 20s;
        client_max_body_size 2m;
    }
    location = /sim2real/mujoco/api {
        proxy_pass http://127.0.0.1:18102/mujoco/api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 20s;
        client_max_body_size 2m;
    }
    location ^~ /sim2real/mujoco/api/ {
        proxy_pass http://127.0.0.1:18102/mujoco/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 20s;
        client_max_body_size 2m;
    }
    # END RDK_MUJOCO_AUTHENTICATED_API
"""

REQUIRED_ROUTE_PARTS = (
    "location = /mujoco { return 301 /mujoco/; }",
    "location /mujoco/ {",
    "proxy_pass http://127.0.0.1:18100/;",
    "proxy_http_version 1.1;",
    "proxy_set_header X-Forwarded-Proto $scheme;",
    "proxy_buffering off;",
    "proxy_read_timeout 1h;",
    "client_max_body_size 2m;",
)


def route_matches(content: str) -> bool:
    exact_location_count = sum(
        line.strip() == "location /mujoco/ {" for line in content.splitlines()
    )
    return exact_location_count == 1 and all(
        part in content for part in REQUIRED_ROUTE_PARTS
    )


def closing_brace(content: str, opening: int) -> int:
    """Find a block end without counting quoted or commented braces."""
    depth = 0
    quote = ""
    comment = False
    for index in range(opening, len(content)):
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
                return index + 1
    return -1


def target_server_block(content: str) -> str:
    """Extract the enclosing HTTPS server, including all its locations."""
    marker = content.find(MARKER)
    if marker < 0:
        return ""
    candidates = list(re.finditer(r"(?m)^[ \t]*server\s*\{", content[:marker]))
    if not candidates:
        return ""
    start = candidates[-1].start()
    opening = candidates[-1].end() - 1
    end = closing_brace(content, opening)
    return content[start:end] if end > marker else ""


def location_blocks(content: str) -> list[tuple[str, str, str]]:
    result = []
    for match in re.finditer(r"(?m)^[ \t]*location\s+(?:(=|\^~)\s+)?(/[^\s{};]+)\s*\{", content):
        end = closing_brace(content, match.end() - 1)
        if end < 0:
            continue
        result.append((match.group(1) or "", match.group(2), content[match.start():end]))
    return result


def api_routes_match(content: str) -> bool:
    expected = {
        ("=", "/mujoco/api"): "proxy_pass http://127.0.0.1:18102;",
        ("^~", "/mujoco/api/"): "proxy_pass http://127.0.0.1:18102;",
        ("=", "/mujoco/lab/api"): "proxy_pass http://127.0.0.1:18102/mujoco/api;",
        ("^~", "/mujoco/lab/api/"): "proxy_pass http://127.0.0.1:18102/mujoco/api/;",
        ("=", "/sim2real/mujoco/api"): "proxy_pass http://127.0.0.1:18102/mujoco/api;",
        ("^~", "/sim2real/mujoco/api/"): "proxy_pass http://127.0.0.1:18102/mujoco/api/;",
    }
    scoped = [entry for entry in location_blocks(content) if entry[1].startswith(("/mujoco/api", "/mujoco/lab/api", "/sim2real/mujoco/api"))]
    if len(scoped) != len(expected):
        return False
    for key, upstream in expected.items():
        matched = [block for modifier, path, block in scoped if (modifier, path) == key]
        if len(matched) != 1:
            return False
        directives = {line.strip() for line in matched[0].splitlines()}
        if not {upstream, "proxy_set_header Host $host;", "proxy_set_header X-Forwarded-Proto $scheme;", "client_max_body_size 2m;"} <= directives:
            return False
    return True


def main() -> None:
    content = CONFIG.read_text()
    if content.count(MARKER) != 1:
        raise SystemExit(f"expected one domain server marker, found {content.count(MARKER)}")
    block = target_server_block(content)
    if not block:
        raise SystemExit("expected rdkstudio HTTPS server block was not found or is unbalanced")
    locations = location_blocks(block)
    existing_api = any(path.startswith(("/mujoco/api", "/mujoco/lab/api", "/sim2real/mujoco/api")) for _, path, _ in locations)
    if existing_api and not api_routes_match(block):
        raise SystemExit(
            "an existing simulation API route does not match the managed block; "
            "review and migrate it manually"
        )
    # Keep existing lab/static/UI routes byte-for-byte. Only the API boundary
    # needs migration; a freshly provisioned host gets the optional lab route.
    has_lab = any(path == "/mujoco/" for _, path, _ in locations)
    additions = ("" if has_lab else ROUTE) + ("" if existing_api else API_ROUTE)
    if not additions:
        print("mujoco API routes already present and validated")
        return
    mode = CONFIG.stat().st_mode & 0o7777
    backup = CONFIG.with_name(f"{CONFIG.name}.bak-mujoco-{time.time_ns()}")
    with backup.open("x", encoding="utf-8") as handle:
        handle.write(content)
    os.chmod(backup, mode)
    updated = content.replace(MARKER, MARKER + additions, 1)
    temporary = CONFIG.with_name(f".{CONFIG.name}.codex-mujoco-{os.getpid()}-{time.time_ns()}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        handle.write(updated)
    os.chmod(temporary, mode)
    os.replace(temporary, CONFIG)
    print(f"updated {CONFIG}; backup={backup}")


if __name__ == "__main__":
    main()
