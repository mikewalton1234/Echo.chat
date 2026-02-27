#!/usr/bin/env python3
import os
import base64
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.backends import default_backend

from constants import KEY_FILE
from security import get_admin_password
import getpass


def encrypt_config(settings, key):
    """
    Encrypt the JSON-serialized settings using Fernet.
    Returns the encrypted bytes.
    """
    import json
    json_data = json.dumps(settings).encode()
    f = Fernet(key)
    return f.encrypt(json_data)


def decrypt_config(encrypted_data, key):
    """
    Decrypt the encrypted configuration bytes using Fernet.
    Returns the settings as a Python dictionary.
    """
    import json
    f = Fernet(key)
    decrypted = f.decrypt(encrypted_data)
    return json.loads(decrypted.decode())


def generate_encryption_key_separate():
    """
    Generate and store a Fernet key in KEY_FILE, if none exists.
    Return the key (bytes).
    """
    if not os.path.exists(KEY_FILE):
        key = Fernet.generate_key()
        with open(KEY_FILE, "wb") as f:
            f.write(key)
    with open(KEY_FILE, "rb") as f:
        return f.read()


def derive_key_from_password(password, salt=None):
    """
    Derive a Fernet key from the provided password using PBKDF2HMAC.
    If salt is not provided, generate a random one and store in KEY_FILE.
    """
    if salt is None:
        salt = os.urandom(16)
        with open(KEY_FILE, "wb") as f:
            f.write(salt)
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100000,
        backend=default_backend()
    )
    key = base64.urlsafe_b64encode(kdf.derive(password.encode()))
    return key


def load_or_generate_key(settings):
    """
    Determine key management approach based on settings:
      - user_provided_key
      - derive_from_password
      - separate_file (default)
    """
    option = settings.get("key_management_option", "separate_file")

    if option == "user_provided_key":
        # The user placed a custom key in KEY_FILE.
        if not os.path.exists(KEY_FILE):
            raise FileNotFoundError("No key file found, but user_provided_key was selected.")
        with open(KEY_FILE, "rb") as f:
            return f.read()

    elif option == "derive_from_password":
        admin_pass = get_admin_password("Enter admin password to derive encryption key: ")
        if os.path.exists(KEY_FILE):
            with open(KEY_FILE, "rb") as f:
                salt = f.read()
        else:
            salt = None
        return derive_key_from_password(admin_pass, salt)

    else:
        # separate_file is default
        return generate_encryption_key_separate()

