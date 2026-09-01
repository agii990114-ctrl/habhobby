# 의존성이 하나도 없다 — node 만 있으면 돈다.
# node:sqlite(내장 DB)와 .ts 직접 실행이 필요해 22.18 이상이어야 한다.
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# 목록·설정이 담기는 곳. 볼륨으로 빼두어야 이미지를 다시 만들어도 살아남는다.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=8080
EXPOSE 8080

# .env 는 이미지에 넣지 않는다. 실행할 때 넣어 주면 이 옵션이 읽고, 없으면 그냥 넘어간다.
CMD ["node", "--no-warnings", "--env-file-if-exists=.env", "src/server.ts"]
