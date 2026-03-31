FROM node:20-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ .
EXPOSE 8000
CMD ["node", "server.js"]
