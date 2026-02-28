#!/usr/bin/env bash
set -euo pipefail

# EchoChat quick self-signed HTTPS setup (dev/LAN)
# - Generates cert/key under ./certs/
# - Updates (or creates) ./server_config.json to enable https
#
# Notes:
# - Browsers will show a warning for self-signed certs.
# - For production, prefer a reverse proxy (Caddy/Nginx) with a real domain + Let's Encrypt.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${ROOT_DIR}/certs"
CFG="${ROOT_DIR}/server_config.json"
EXAMPLE="${ROOT_DIR}/settings.example.json"

mkdir -p "${CERT_DIR}"

CRT="${CERT_DIR}/echochat.crt"
KEY="${CERT_DIR}/echochat.key"
OPENSSL_CNF="${CERT_DIR}/openssl_san.cnf"

HOSTNAME="$(hostname 2>/dev/null || echo echochat)"
# best-effort IP discovery (space separated)
IPS="$(hostname -I 2>/dev/null || true)"

# Build SAN list: localhost + 127.0.0.1 + hostname + any detected IPs
SAN_DNS="DNS:localhost,DNS:${HOSTNAME}"
SAN_IP="IP:127.0.0.1"
for ip in ${IPS}; do
  # skip weird entries
  [[ "${ip}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  SAN_IP="${SAN_IP},IP:${ip}"
done

cat > "${OPENSSL_CNF}" <<EOF
[ req ]
default_bits       = 2048
prompt             = no
default_md         = sha256
distinguished_name = dn
x509_extensions    = v3_req

[ dn ]
C  = US
ST = State
L  = City
O  = EchoChat
OU = Dev
CN = ${HOSTNAME}

[ v3_req ]
subjectAltName = ${SAN_DNS},${SAN_IP}
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EOF

echo "🔐 Generating self-signed cert with SANs: ${SAN_DNS},${SAN_IP}"
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout "${KEY}" -out "${CRT}" \
  -config "${OPENSSL_CNF}"

chmod 600 "${KEY}"
chmod 644 "${CRT}"

# Create config if missing
if [[ ! -f "${CFG}" ]]; then
  if [[ -f "${EXAMPLE}" ]]; then
    echo "📄 Creating server_config.json from settings.example.json"
    cp -f "${EXAMPLE}" "${CFG}"
  else
    echo "{}" > "${CFG}"
  fi
fi

# Update JSON using python (preserves other keys)
python3 - <<PY
import json
from pathlib import Path

cfg_path = Path(r"${CFG}")
data = json.loads(cfg_path.read_text("utf-8") or "{}")

data["https"] = True
data["ssl_cert_file"] = "certs/echochat.crt"
data["ssl_key_file"] = "certs/echochat.key"
# cookie_secure should be True when https is enabled
data["cookie_secure"] = True

cfg_path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", "utf-8")
print("✅ Updated", cfg_path)
PY

echo
echo "✅ Done."
echo "Next:"
echo "  1) python main.py"
echo "  2) Open: https://<your-host>:5000/login"
echo
