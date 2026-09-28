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
# 保存先は永続ディスクの上へ置きます。イメージの中（/app/data）へ書くと、
# デプロイのたびにコンテナごと作り直されて、本番でつけた内容が消えます。
# Renderのディスクは render.yaml で /var/lib/school-bus へマウントします。
ENV DATA_FILE=/var/lib/school-bus/store.json
# 保存先が空のときだけ、同梱のダイヤを初回に複製します。保存先と同じパスに
# しないでください。同じだと複製を飛ばし、種ファイルそのものへ書き込みます。
ENV SEED_FILE=/app/data/store.json
EXPOSE 8080
ENTRYPOINT ["/app/school-bus"]
