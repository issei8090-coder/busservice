FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY web ./web
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/school-bus .

# Renderの永続ディスクへ書き込むためrootで実行します。シェルを持たない最小構成は維持します。
FROM gcr.io/distroless/static-debian12
WORKDIR /app
COPY --from=build /out/school-bus /app/school-bus
COPY data /app/data
ENV PORT=8080
ENV DATA_FILE=/app/data/store.json
# 保存先が空の環境では同梱ダイヤを初回だけ複製します。
ENV SEED_FILE=/app/data/store.json
EXPOSE 8080
ENTRYPOINT ["/app/school-bus"]
