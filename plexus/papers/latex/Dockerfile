FROM texlive/texlive:latest

RUN apt-get update && apt-get install -y pandoc && rm -rf /var/lib/apt/lists/*

WORKDIR /papers

COPY . .

# Default: build all five papers
CMD ["sh", "/papers/build-all.sh"]
