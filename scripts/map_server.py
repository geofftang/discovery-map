#!/usr/bin/env python3
import os
import sys
import time
import hmac
import hashlib
import secrets
import urllib.parse
from http import cookies
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = 8082
VAULT_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(VAULT_DIR, 'dist')

PASSPHRASE_FILE = os.path.join(VAULT_DIR, '.vault_passphrase')
COOKIE_SECRET_FILE = os.path.join(VAULT_DIR, '.vault_cookie_secret')

# Ensure cookie secret persists across restarts
if os.path.exists(COOKIE_SECRET_FILE):
    with open(COOKIE_SECRET_FILE, 'rb') as f:
        COOKIE_SECRET = f.read().strip()
else:
    COOKIE_SECRET = secrets.token_bytes(32)
    with open(COOKIE_SECRET_FILE, 'wb') as f:
        f.write(COOKIE_SECRET)

def get_passphrase():
    if os.environ.get('VAULT_PASSPHRASE'):
        return os.environ['VAULT_PASSPHRASE'].strip()
    if os.path.exists(PASSPHRASE_FILE):
        with open(PASSPHRASE_FILE, 'r', encoding='utf-8') as f:
            return f.read().strip()
    default_pass = 'discovery-vault-2026'
    with open(PASSPHRASE_FILE, 'w', encoding='utf-8') as f:
        f.write(default_pass)
    return default_pass

def get_signing_key():
    return hashlib.sha256(COOKIE_SECRET + get_passphrase().encode('utf-8')).digest()

def generate_auth_token():
    ts = str(int(time.time()))
    sig = hmac.new(get_signing_key(), ts.encode(), hashlib.sha256).hexdigest()
    return f"{ts}.{sig}"

def verify_auth_token(token):
    if not token or '.' not in token:
        return False
    try:
        ts_str, sig = token.split('.', 1)
        ts = int(ts_str)
        # Token valid for 1 year (365 days)
        if time.time() - ts > 365 * 86400:
            return False
        expected = hmac.new(get_signing_key(), ts_str.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, expected)
    except Exception:
        return False

LOGIN_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Unlock Vault - Discovery Map</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🔒</text></svg>">
  <style>
    :root {
      --bg: #090b10;
      --card-bg: rgba(21, 25, 34, 0.85);
      --card-border: rgba(255, 255, 255, 0.1);
      --text-main: #f0f3f6;
      --text-muted: #8b949e;
      --green: #3fb950;
      --accent: #58a6ff;
      --orange: #f0883e;
      --danger: #f85149;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(circle at 50% 0%, rgba(56, 114, 224, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, rgba(63, 185, 80, 0.08) 0%, transparent 40%);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      width: 100%;
      max-width: 400px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 2.25rem 2rem;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
      text-align: center;
    }
    .icon {
      width: 56px;
      height: 56px;
      margin: 0 auto 1.25rem;
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(63, 185, 80, 0.12);
      border: 1px solid rgba(63, 185, 80, 0.25);
      color: var(--green);
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 0.4rem;
    }
    p.desc {
      font-size: 0.9rem;
      color: var(--text-muted);
      margin-bottom: 1.75rem;
      line-height: 1.45;
    }
    .error-msg {
      background: rgba(248, 81, 73, 0.15);
      border: 1px solid rgba(248, 81, 73, 0.3);
      color: var(--danger);
      font-size: 0.85rem;
      padding: 0.65rem 0.85rem;
      border-radius: 8px;
      margin-bottom: 1.25rem;
    }
    .form-group {
      margin-bottom: 1.25rem;
      text-align: left;
    }
    label {
      display: block;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      font-weight: 600;
      margin-bottom: 0.4rem;
    }
    input[type="password"] {
      width: 100%;
      padding: 0.85rem 1rem;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      color: var(--text-main);
      font-size: 1rem;
      outline: none;
      transition: border-color 0.15s ease;
    }
    input[type="password"]:focus {
      border-color: var(--green);
      box-shadow: 0 0 0 3px rgba(63, 185, 80, 0.15);
    }
    button.submit-btn {
      width: 100%;
      padding: 0.9rem;
      border-radius: 10px;
      background: var(--green);
      border: none;
      color: #0d1117;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.1s ease, filter 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    button.submit-btn:hover {
      filter: brightness(1.1);
    }
    button.submit-btn:active {
      transform: scale(0.98);
    }
    .footer-note {
      margin-top: 1.5rem;
      font-size: 0.78rem;
      color: var(--text-muted);
      line-height: 1.4;
    }
    .footer-note span {
      color: #c9d1d9;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
    </div>
    <h1>Personal Vault</h1>
    <p class="desc">Enter your passphrase to access Discovery Map on map.efsystem.uk.</p>

    <!--ERROR_PLACEHOLDER-->

    <form method="POST" action="/login">
      <input type="hidden" name="username" value="geoff" autocomplete="username">
      <div class="form-group">
        <label for="passphrase">Vault Passphrase</label>
        <input type="password" id="passphrase" name="passphrase" autocomplete="current-password" placeholder="Passphrase" required autofocus>
      </div>
      <button type="submit" class="submit-btn">
        Unlock Vault
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M5 12h14M12 5l7 7-7 7"/>
        </svg>
      </button>
    </form>

    <div class="footer-note">
      🔒 <span>Face ID / Touch ID:</span> Safari will prompt to save this in iCloud Keychain for seamless biometric unlock.
    </div>
  </div>
</body>
</html>
"""

class MapVaultHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def is_authenticated(self):
        cookie_header = self.headers.get('Cookie')
        if not cookie_header:
            return False
        try:
            c = cookies.SimpleCookie()
            c.load(cookie_header)
            if 'map_vault_auth' in c:
                token = c['map_vault_auth'].value
                return verify_auth_token(token)
        except Exception:
            pass
        return False

    def do_POST(self):
        clean_path = urllib.parse.urlparse(self.path).path.rstrip('/')
        if clean_path == '/login':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length).decode('utf-8', errors='replace')
            params = urllib.parse.parse_qs(post_data)
            submitted_pass = params.get('passphrase', [''])[0].strip()

            actual_pass = get_passphrase()
            if hmac.compare_digest(submitted_pass, actual_pass):
                token = generate_auth_token()
                self.send_response(303)
                self.send_header('Location', '/')
                cookie_val = f"map_vault_auth={token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax"
                self.send_header('Set-Cookie', cookie_val)
                self.end_headers()
                return
            else:
                error_banner = '<div class="error-msg">Incorrect passphrase. Please try again.</div>'
                body = LOGIN_HTML.replace('<!--ERROR_PLACEHOLDER-->', error_banner).encode('utf-8')
                self.send_response(401)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

        self.send_error(404, "Not Found")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        clean_path = parsed.path

        if clean_path.rstrip('/') == '/logout':
            self.send_response(303)
            self.send_header('Location', '/')
            self.send_header('Set-Cookie', 'map_vault_auth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax')
            self.end_headers()
            return

        if not self.is_authenticated():
            if clean_path in ('/', '/index.html'):
                body = LOGIN_HTML.replace('<!--ERROR_PLACEHOLDER-->', '').encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            else:
                error_json = b'{"error": "Unauthorized: Access to Discovery Map personal vault requires authentication."}\n'
                self.send_response(401)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(error_json)))
                self.end_headers()
                self.wfile.write(error_json)
                return

        return super().do_GET()

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        clean_path = parsed.path
        if not self.is_authenticated():
            if clean_path in ('/', '/index.html'):
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.end_headers()
                return
            else:
                self.send_response(401)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                return
        return super().do_HEAD()

if __name__ == '__main__':
    server_address = ('127.0.0.1', PORT)
    httpd = HTTPServer(server_address, MapVaultHandler)
    print(f"MapVaultHandler serving {STATIC_DIR} on 127.0.0.1:{PORT}...")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        httpd.server_close()
