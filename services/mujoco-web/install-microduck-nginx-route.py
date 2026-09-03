from pathlib import Path
import os
import time


CONFIG = Path("/etc/nginx/conf.d/rdkstudio-ssl.conf")
MARKER = "    location = /mujoco { return 301 /mujoco/; }\n"
ROUTE = """
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
"""


def main() -> None:
    content = CONFIG.read_text()
    if "location /mujoco/microduck/" in content:
        print("microduck route already present")
        return
    if MARKER not in content:
        raise SystemExit("existing MuJoCo route marker not found")
    if "location /mujoco/" not in content:
        raise SystemExit("existing MuJoCo fallback route not found")
    backup = CONFIG.with_name(f"{CONFIG.name}.bak-microduck-{int(time.time())}")
    backup.write_text(content)
    updated = content.replace(MARKER, MARKER + ROUTE, 1)
    temporary = CONFIG.with_name(f".{CONFIG.name}.codex-microduck.tmp")
    temporary.write_text(updated)
    os.replace(temporary, CONFIG)
    print(f"updated {CONFIG}; backup={backup}")


if __name__ == "__main__":
    main()
