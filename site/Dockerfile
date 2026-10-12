FROM node:22-alpine

WORKDIR /app
COPY server.mjs password.mjs ./
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV PORT=8080
ENV DATA_DIR=/app/data
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
