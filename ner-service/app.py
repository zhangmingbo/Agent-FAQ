"""
NER 命名实体识别服务
基于 CLUENER 模型 + 正则后处理
支持：地址、人名、公司、组织、电话、邮箱、日期、时间
"""

import re
import json
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import pipeline
import uvicorn
import numpy as np

app = FastAPI(title="NER Service", version="1.0.0")

# 加载 CLUENER 模型（首次启动会自动下载）
print("[NER] 正在加载 CLUENER 模型...")
ner_pipeline = pipeline("ner", model="uer/roberta-base-finetuned-cluener2020-chinese", aggregation_strategy="simple")
print("[NER] 模型加载完成")

# CLUENER 标签映射
LABEL_MAP = {
    "address": "address",      # 地址
    "name": "name",            # 人名
    "company": "company",      # 公司
    "organization": "organization",  # 组织
    "government": "government",      # 政府
    "position": "position",          # 职位
    "scene": "scene",                # 景点
}


class ExtractRequest(BaseModel):
    text: str


def merge_entities(raw_entities):
    """合并同类型实体，去除字间空格"""
    entities = {}
    for ent in raw_entities:
        label = ent.get("entity_group") or ent.get("entity", "")
        word = ent.get("word", "").replace(" ", "")  # 去除模型产生的空格
        score = float(ent.get("score", 0))  # 转换为 Python float

        # 过滤低置信度
        if score < 0.5:
            continue

        # 映射标签
        mapped_label = LABEL_MAP.get(label, label)
        if mapped_label not in entities:
            entities[mapped_label] = []

        # 去重
        if word not in entities[mapped_label]:
            entities[mapped_label].append(word)

    return entities


def regex_post_process(text, entities):
    """正则补充 CLUENER 不覆盖的实体类型"""
    # 电话号码（中国大陆手机号）
    phones = re.findall(r'1[3-9]\d{9}', text)
    if phones:
        entities.setdefault('phone', []).extend(phones)

    # 邮箱
    emails = re.findall(r'[\w.+-]+@[\w-]+\.[\w.]+', text)
    if emails:
        entities.setdefault('email', []).extend(emails)

    # 日期（多种格式）
    dates = re.findall(r'\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?', text)
    dates += re.findall(r'\d{1,2}[-/月]\d{1,2}[日号]?', text)
    dates += re.findall(r'(今天|明天|后天|大后天|昨天|前天|本周一|下周一|上周[一二三四五六日])', text)
    if dates:
        entities.setdefault('date', []).extend(dates)

    # 时间
    times = re.findall(r'\d{1,2}[点时]:?\d{0,2}(?:分)?(?:秒)?', text)
    times += re.findall(r'(上午|下午|晚上|早上|中午|傍晚|凌晨)\d{0,2}[点时]?', text)
    times += re.findall(r'(早上|上午|中午|下午|晚上|傍晚|凌晨|深夜)', text)
    if times:
        entities.setdefault('time', []).extend(times)

    return entities


@app.post("/extract")
async def extract(request: ExtractRequest):
    """从文本中提取命名实体"""
    try:
        text = request.text.strip()
        if not text:
            return {"entities": {}, "raw": []}

        # NER 模型提取
        raw_results = ner_pipeline(text)

        # 合并实体
        entities = merge_entities(raw_results)

        # 正则后处理
        entities = regex_post_process(text, entities)

        return {
            "entities": entities,
            "raw": [{"entity_group": r.get("entity_group", ""), "score": float(r.get("score", 0)), "word": r.get("word", "").replace(" ", ""), "start": r.get("start", 0), "end": r.get("end", 0)} for r in raw_results],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health():
    """健康检查"""
    return {"status": "ok", "model": "CLUENER"}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8766)
