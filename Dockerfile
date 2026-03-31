FROM node:20-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ .
EXPOSE 8500
ENV PORT=8500
ENV BASE_PATH=/video-library
CMD ["node", "server.js"]
