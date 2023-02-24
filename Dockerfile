FROM tiangolo/uvicorn-gunicorn-fastapi:python3.7

COPY ./requirements.txt requirements.txt

RUN python -m pip install pip --upgrade
RUN python -m pip install -r requirements.txt

COPY ./src ./src
COPY ./static ./static
COPY ./templates ./templates

CMD ["python", "src/main.py"]
