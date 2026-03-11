# 1. 使用官方 Node.js 镜像（这里不使用 slim 版本，是为了避免 better-sqlite3 等原生依赖在安装时因缺少编译工具而报错）
FROM node:20

# 2. 设置容器内的工作目录
WORKDIR /app

# 3. 复制 package.json 和 package-lock.json（如果有）
COPY package*.json ./

# 4. 安装项目的所有依赖
RUN npm install

# 5. 复制项目的所有源代码到容器中
COPY . .

# 6. 如果你的 Vite 前端代码需要在这里进行生产环境构建，请取消下面这行注释：
# RUN npm run build

# 7. 设置环境变量，告知应用运行在哪个端口（Cloud Run 强烈推荐的做法）
ENV PORT=8080

# 8. 暴露 8080 端口供 Cloud Run 接收流量
EXPOSE 8080

# 9. 启动命令：使用 tsx 运行后端的 server.ts
CMD ["npx", "tsx", "server.ts"]