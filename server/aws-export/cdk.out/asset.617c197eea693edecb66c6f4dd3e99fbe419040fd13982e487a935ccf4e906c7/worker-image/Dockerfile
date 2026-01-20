FROM public.ecr.aws/lambda/nodejs:20 AS builder

# Install tools needed to fetch a static ffmpeg build.
RUN yum -y install curl tar xz ; yum clean all

# Download a static ffmpeg build (x86_64). Update URL/version as needed.
RUN mkdir -p /opt/ffmpeg \
  ; curl -L "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" -o /tmp/ffmpeg.tar.xz \
  ; tar -xf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1

WORKDIR /var/task

# Install build deps
COPY worker-image/package.json worker-image/package-lock.json* ./
RUN npm install

# Copy TypeScript sources (from the docker build context root)
COPY src ./src

# Bundle worker entrypoint (includes shared code + AWS SDK v3 deps)
RUN npx esbuild src/worker/handler.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist/index.cjs


FROM public.ecr.aws/lambda/nodejs:20

RUN yum -y install tar xz ; yum clean all

# ffmpeg
COPY --from=builder /opt/ffmpeg /opt/ffmpeg
RUN ln -sf /opt/ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
  ; ln -sf /opt/ffmpeg/ffprobe /usr/local/bin/ffprobe

# Lambda code
COPY --from=builder /var/task/dist/index.cjs ${LAMBDA_TASK_ROOT}/index.cjs

CMD ["index.handler"]
