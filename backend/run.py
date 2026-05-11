import os

from app import create_app

app = create_app()


if __name__ == "__main__":
    debug = os.getenv("FLASK_DEBUG", "0").lower() in ("1", "true", "yes")
    host = os.getenv("FLASK_HOST", "0.0.0.0")
    port = int(os.getenv("FLASK_PORT", "5000"))

    if debug:
        app.run(host=host, port=port, debug=True)
    else:
        from waitress import serve

        threads = int(os.getenv("WAITRESS_THREADS", "4"))
        serve(app, host=host, port=port, threads=threads)
