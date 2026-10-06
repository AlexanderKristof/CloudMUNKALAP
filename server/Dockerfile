FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data TZ=Europe/Budapest
VOLUME /data
EXPOSE 3000
CMD ["node", "src/index.js"]
