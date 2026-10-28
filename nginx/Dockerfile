# syntax=docker/dockerfile:1
# Build context is the repository root.
FROM node:24-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
RUN npm run build

FROM nginx:1.30.6-alpine
# pcms.conf = HTTP (dev, local test); pcms-tls.conf = HTTPS (production)
ARG NGINX_CONF=pcms.conf
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx/snippets/ /etc/nginx/snippets/
COPY nginx/${NGINX_CONF} /etc/nginx/conf.d/pcms.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080 8443 8081 8082
