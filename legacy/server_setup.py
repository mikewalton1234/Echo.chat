#!/usr/bin/env python3
import os
import logging
import subprocess


def auto_configure_nginx(settings):
    """
    Auto-install and configure Nginx on Debian/Ubuntu.
    Sets up a reverse proxy from port 80/443 to the Flask app on server_port.
    """
    hostname = settings.get("domain_name", "example.com")
    server_port = settings.get("server_port", 5000)
    ssl_enabled = settings.get("ssl_tls_settings", {}).get("enabled", False)
    cert_path = settings.get("ssl_tls_settings", {}).get("certificate_path", "/etc/ssl/certs/server.crt")
    key_path = settings.get("ssl_tls_settings", {}).get("key_path", "/etc/ssl/private/server.key")

    # 1. Check if running as root:
    if os.geteuid() != 0:
        logging.error("Nginx auto-configuration requires root privileges. Please run as root or use sudo.")
        return

    # 2. Ensure Nginx is installed:
    try:
        subprocess.run(["which", "nginx"], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        logging.info("Nginx is already installed.")
    except subprocess.CalledProcessError:
        logging.info("Nginx not found. Installing...")
        try:
            subprocess.run(["apt-get", "update"], check=True)
            subprocess.run(["apt-get", "-y", "install", "nginx"], check=True)
            logging.info("Nginx installed successfully.")
        except Exception as e:
            logging.error("Failed to install Nginx automatically: %s", e)
            return

    # 3. Create a new Nginx server block
    server_block = f"""
server {{
    listen 80;
    server_name {hostname};

    location / {{
        proxy_pass http://127.0.0.1:{server_port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }}
}}
"""
    if ssl_enabled:
        server_block += f"""

server {{
    listen 443 ssl;
    server_name {hostname};

    ssl_certificate {cert_path};
    ssl_certificate_key {key_path};

    location / {{
        proxy_pass http://127.0.0.1:{server_port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }}
}}
"""

    # 4. Write the config file to /etc/nginx/sites-available/chat_app.conf
    config_filename = "/etc/nginx/sites-available/chat_app.conf"
    try:
        with open(config_filename, "w") as f:
            f.write(server_block.strip() + "\n")
        logging.info("Nginx config written to %s", config_filename)
    except Exception as e:
        logging.error("Failed to write Nginx config: %s", e)
        return

    # 5. Symlink to sites-enabled
    enabled_path = "/etc/nginx/sites-enabled/chat_app.conf"
    if not os.path.islink(enabled_path):
        try:
            if os.path.exists(enabled_path):
                os.remove(enabled_path)
            os.symlink(config_filename, enabled_path)
            logging.info("Enabled Nginx site: %s", enabled_path)
        except Exception as e:
            logging.error("Failed to enable Nginx site: %s", e)
            return

    # 6. Optionally remove the default site
    default_site = "/etc/nginx/sites-enabled/default"
    if os.path.exists(default_site):
        try:
            os.remove(default_site)
            logging.info("Disabled default Nginx site.")
        except Exception:
            pass

    # 7. Reload or restart Nginx
    try:
        subprocess.run(["systemctl", "reload", "nginx"], check=True)
        logging.info("Nginx reloaded successfully.")
    except Exception as e:
        logging.error("Failed to reload Nginx: %s", e)
        return

    logging.info("Nginx auto-configuration complete.")
