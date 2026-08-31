---
trigger: always_on
---
# 强制存档规则（每次会话生效）
每次完成一个用户请求（写完代码、改完文件、修完 bug）后，必须依次执行：
1. git add -A
2. git commit -m "feat: <本次改动的简短中文摘要>"
3. 如果 git status 显示无改动，跳过提交即可
