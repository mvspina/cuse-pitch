FROM node:20-alpine

WORKDIR /app
COPY . .

RUN npm install
RUN npm run install:all
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3001
CMD ["npm","run","start"]
