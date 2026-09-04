from pathlib import Path
import os
import time


CONFIG = Path(os.environ.get("RDK_SIM2REAL_NGINX_CONFIG", "/etc/nginx/conf.d/rdkstudio-ssl.conf"))
SERVER_MARKER = "    server_name rdkstudio.d-robotics.cc;\n"
MARKER = "    location = /mujoco { return 301 /mujoco/; }\n"
ROUTE = """
    # BEGIN RDK_MICRODUCK_MANAGED_ROUTE
    location = /mujoco/microduck { return 301 /mujoco/microduck/; }
    location = /mujoco/ { return 302 /mujoco/microduck/; }
    location = /mujoco/lab { return 301 /mujoco/lab/; }
    location /mujoco/lab/ {
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
    location /mujoco/microduck/ {
        proxy_pass http://127.0.0.1:18101/;
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
    # END RDK_MICRODUCK_MANAGED_ROUTE
"""

REQUIRED_ROUTE_PARTS = (
    "location = /mujoco/microduck { return 301 /mujoco/microduck/; }",
    "location = /mujoco/ { return 302 /mujoco/microduck/; }",
    "location = /mujoco/lab { return 301 /mujoco/lab/; }",
    "location /mujoco/lab/ {",
    "proxy_pass http://127.0.0.1:18100/;",
    "location /mujoco/microduck/ {",
    "proxy_pass http://127.0.0.1:18101/;",
    "proxy_http_version 1.1;",
    "proxy_set_header X-Forwarded-Proto $scheme;",
    "proxy_buffering off;",
    "proxy_read_timeout 1h;",
    "client_max_body_size 2m;",
)

BASE_ROUTE_PARTS = (
    "location = /mujoco { return 301 /mujoco/; }",
    "location /mujoco/ {",
    "proxy_pass http://127.0.0.1:18100/;",
)


def route_matches(content: str) -> bool:
    return all(part in content for part in REQUIRED_ROUTE_PARTS) and all(
        content.count(part) == 1
        for part in (
            "location /mujoco/microduck/ {",
            "location /mujoco/lab/ {",
            "location = /mujoco/microduck { return 301 /mujoco/microduck/; }",
        )
    )


def base_route_matches(content: str) -> bool:
    return sum(line.strip() == "location /mujoco/ {" for line in content.splitlines()) == 1 and all(
        part in content for part in BASE_ROUTE_PARTS
    )


def target_server_block(content: str) -> str:
    """Extract the configured HTTPS server block, including nested locations."""
    start = content.find(SERVER_MARKER)
    if start < 0:
        return ""
    opening = content.find("{", start)
    if opening < 0:
        return ""
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
                return content[start : index + 1]
    return ""


def main() -> None:
    content = CONFIG.read_text()
    if content.count(SERVER_MARKER) != 1:
        raise SystemExit(f"expected one domain server marker, found {content.count(SERVER_MARKER)}")
    block = target_server_block(content)
    if not block:
        raise SystemExit("expected rdkstudio HTTPS server block was not found or is unbalanced")
    if "location /mujoco/microduck/" in content:
        if route_matches(block):
            print("microduck route already present and validated")
            return
        raise SystemExit(
            "an existing /mujoco/microduck/ route does not match the managed block; "
            "review and migrate it manually"
        )
    if MARKER not in block:
        raise SystemExit("existing MuJoCo route marker not found")
    if not base_route_matches(block):
        raise SystemExit(
            "existing MuJoCo fallback route is missing or points at an unexpected port; "
            "run the base installer or migrate it manually"
        )
    mode = CONFIG.stat().st_mode & 0o7777
    backup = CONFIG.with_name(f"{CONFIG.name}.bak-microduck-{time.time_ns()}")
    with backup.open("x", encoding="utf-8") as handle:
        handle.write(content)
    os.chmod(backup, mode)
    updated = content.replace(MARKER, MARKER + ROUTE, 1)
    temporary = CONFIG.with_name(f".{CONFIG.name}.codex-microduck.tmp")
    temporary.write_text(updated)
    os.chmod(temporary, mode)
    os.replace(temporary, CONFIG)
    print(f"updated {CONFIG}; backup={backup}")


if __name__ == "__main__":
    main()
