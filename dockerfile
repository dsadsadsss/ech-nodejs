FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production

# 复制应用代码
COPY index.js ./

# 暴露端口
EXPOSE 3000

# 设置环境变量(可以在运行时覆盖)
ENV PORT=3000

# 启动应用
CMD ["node", "index.js"]