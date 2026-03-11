# 1. 使用 Node.js 20 官方镜像
FROM node:20

# 2. 设置工作目录
WORKDIR /app

# 3. 复制 package.json 安装依赖
COPY package*.json ./
# 必须安装所有依赖，因为 build 阶段需要用到 Vite 等 devDependencies
RUN npm install

# 4. 复制所有源代码
COPY . .

# 5. 关键修复：执行 Vite 前端构建，生成 dist 文件夹！
RUN npm run build

# 6. 关键修复：设置环境变量为生产环境，告诉 server.ts 不要启动 Vite 开发服务器
ENV NODE_ENV=production

# 7. 设置端口环境变量
ENV PORT=8080
EXPOSE 8080

# 8. 启动服务器
CMD ["npx", "tsx", "server.ts"]