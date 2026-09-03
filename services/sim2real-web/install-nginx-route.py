from pathlib import Path
import os
import time


CONFIG = Path(os.environ.get("RDK_SIM2REAL_NGINX_CONFIG", "/etc/nginx/conf.d/rdkstudio-ssl.conf"))
MARKER = "    server_name rdkstudio.d-robotics.cc;\n"
ROUTE = """
    location = /sim2real { return 301 /sim2real/; }
    location /sim2real/ {
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
"""


def main() -> None:
    content = CONFIG.read_text()
    if "location /sim2real/" in content:
        print("sim2real route already present")
        return
    if MARKER not in content:
        raise SystemExit("expected rdkstudio HTTPS server marker was not found")
    backup = CONFIG.with_name(f"{CONFIG.name}.bak-sim2real-{int(time.time())}")
    backup.write_text(content)
    updated = content.replace(MARKER, MARKER + ROUTE, 1)
    temporary = CONFIG.with_name(f".{CONFIG.name}.codex-sim2real.tmp")
    temporary.write_text(updated)
    os.replace(temporary, CONFIG)
    print(f"updated {CONFIG}; backup={backup}")


if __name__ == "__main__":
    main()
