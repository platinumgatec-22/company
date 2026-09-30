FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/company.db PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
