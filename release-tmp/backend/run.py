import os

from app import create_app

app = create_app()


if __name__ == "__main__":
    use_https = os.getenv("FLASK_USE_HTTPS", "0") in ("1", "true", "True")
    cert_path = os.getenv("FLASK_SSL_CERT", "").strip()
    key_path = os.getenv("FLASK_SSL_KEY", "").strip()
    ssl_context = None
    if use_https:
        ssl_context = (cert_path, key_path) if cert_path and key_path else "adhoc"
    app.run(host="0.0.0.0", port=5000, debug=True, ssl_context=ssl_context)
