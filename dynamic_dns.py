#!/usr/bin/env python3
import logging
import requests  # third-party
from requests.auth import HTTPBasicAuth

def update_dynamic_dns(settings):
    """
    If dynamic DNS is enabled, retrieve current public IP and update DNS record.
    """
    if settings.get("dynamic_dns_enabled", False):
        username = settings.get("dynamic_dns_username")
        password = settings.get("dynamic_dns_password")
        domain = settings.get("dynamic_dns_domain")
        update_url = settings.get("dynamic_dns_update_url")

        try:
            ip_response = requests.get("https://api.ipify.org")
            current_ip = ip_response.text.strip()
            logging.info("Current public IP: %s", current_ip)
        except Exception as e:
            logging.error("Failed to retrieve current IP address: %s", e)
            return

        params = {"hostname": domain, "myip": current_ip}
        try:
            response = requests.get(
                update_url,
                params=params,
                auth=HTTPBasicAuth(username, password),
            )
            if response.status_code == 200:
                logging.info("Dynamic DNS update successful: %s", response.text)
            else:
                logging.error("Dynamic DNS update failed: %s", response.text)
        except Exception as e:
            logging.error("Error during Dynamic DNS update: %s", e)

def test_dynamic_dns_update(settings):
    """
    Test the dynamic DNS update by calling update_dynamic_dns().
    """
    if settings.get("dynamic_dns_enabled", False):
        print("Testing Dynamic DNS update...")
        update_dynamic_dns(settings)
        print("Check your DDNS provider's dashboard/logs for verification.")
