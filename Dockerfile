FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
ENV DATA_FILE=/data/models.db
ENV PHOTOS_DIR=/app/photos
EXPOSE 8333
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8333"]
