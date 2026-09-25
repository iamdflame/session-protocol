# The devnet keepers on Railway. The image holds two bundled scripts and the
# public manifests; the keys arrive as service variables (start.sh).
FROM node:24-slim
WORKDIR /app
COPY . .
ENV NODE_NO_WARNINGS=1
CMD ["sh", "start.sh"]
