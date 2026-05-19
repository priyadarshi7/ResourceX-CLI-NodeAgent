FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0
ENV MONGODB_URI=mongodb://mongo:27017/resourcex

EXPOSE 4000

CMD ["node", "src/index.js"]
