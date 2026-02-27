#!/usr/bin/env python3
import os
import json
import base64
import logging

from cryptography.fernet import Fernet

from constants import CONFIG_FILE
from encryption import encrypt_config, decrypt_config
from interactive_setup import get_default_settings


def load_config(key):
    """
    Load and decrypt the configuration from CONFIG_FILE, returning a dict.
    If the file doesn't exist or decryption fails, return default settings.
    """
    try:
        if not os.path.exists(CONFIG_FILE):
            return get_default_settings()

        with open(CONFIG_FILE, "rb") as f:
            data = f.read()

        # EchoChat's current main path uses *plaintext JSON* for server_config.json.
        # Older/experimental flows used Fernet-encrypted bytes.
        # Detect JSON first; fall back to Fernet decryption.
        try:
            text = data.decode("utf-8").strip()
            if text.startswith("{") and text.endswith("}"):
                return json.loads(text)
        except Exception:
            pass

        return decrypt_config(data, key)
    except Exception as e:
        logging.error("Failed to load configuration: %s", str(e))
        return get_default_settings()


def save_config(settings, key):
    """
    Encrypt and save the settings dictionary to CONFIG_FILE.
    """
    try:
        encrypted_data = encrypt_config(settings, key)
        with open(CONFIG_FILE, "wb") as f:
            f.write(encrypted_data)
        logging.info("Configuration saved successfully.")
    except Exception as e:
        logging.error("Failed to save configuration: %s", str(e))
        raise
