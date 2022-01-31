# syntax=docker/dockerfile:1

FROM node:14-alpine as base-stage

WORKDIR /app

COPY package.json ./

RUN npm install

COPY . .


FROM base-stage as production

CMD ["echo", "Start build"] 

#ENV NODE_PATH=./build

RUN npm run build

CMD ["echo", "Executing node"]

EXPOSE 8080:8080
EXPOSE 80:80
ENV SO_ENV=production
ENV LISTEN_PORT=8080
# This needs to be explicitly set -- we can't rely on
# the docker-compose "command" since it doesn't get run
# by ECS in AWS. ECS just runs "docker run <image>", not
# "docker compose -f <compose-file> up"
CMD ["node", "server/server.js"]
