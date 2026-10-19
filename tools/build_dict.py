# -*- coding: utf-8 -*-
"""
词库构建脚本：从 GitHub 开源仓库 KyleBing/english-vocabulary 下载四级/六级词汇 txt，
解析为 {单词: {level, defs:[{pos, meaning}]}} 结构，输出 js/data_cet.js
运行：python tools/build_dict.py
"""
import json
import os
import re
import urllib.request

BASE = "https://raw.githubusercontent.com/KyleBing/english-vocabulary/master/"
HERE = os.path.dirname(os.path.abspath(__file__))
SOURCES = [
    ("CET4", os.path.join(HERE, "cet4.txt"), BASE + "3%20%E5%9B%9B%E7%BA%A7-%E4%B9%B1%E5%BA%8F.txt"),
    ("CET6", os.path.join(HERE, "cet6.txt"), BASE + "4%20%E5%85%AD%E7%BA%A7-%E4%B9%B1%E5%BA%8F.txt"),
]

OUT = os.path.join(os.path.dirname(__file__), "..", "js", "data_cet.js")

# 词性标记：纯小写字母+点号，如 n. v. vt. vi. adj. adv. prep. conj. pron. num. int. art. aux. abbr.
POS_RE = re.compile(r"^[a-z]{1,5}\.$", re.I)
WORD_RE = re.compile(r"^[a-zA-Z][a-zA-Z\-'\. ]*$")
MAX_DEFS = 3  # 每个单词最多保留 3 条释义


def download(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8")


def parse_line(line):
    """解析一行: 'access  v. 获取 n. 接近，入口' -> (word, [(pos, meaning), ...])"""
    tokens = line.split()
    if not tokens:
        return None
    first_pos = next((i for i, t in enumerate(tokens) if POS_RE.match(t)), None)
    if first_pos is None or first_pos == 0:
        return None
    word = " ".join(tokens[:first_pos]).strip()
    if not WORD_RE.match(word):
        return None
    defs = []
    cur_pos, cur_mean = None, []
    for t in tokens[first_pos:]:
        if POS_RE.match(t):
            if cur_pos and cur_mean:
                defs.append((cur_pos.lower(), " ".join(cur_mean)))
            cur_pos, cur_mean = t, []
        else:
            cur_mean.append(t)
    if cur_pos and cur_mean:
        defs.append((cur_pos.lower(), " ".join(cur_mean)))
    if not defs:
        return None
    return word.lower(), defs


def main():
    dictionary = {}
    stats = {}
    for level, local_path, url in SOURCES:
        if os.path.exists(local_path):
            with open(local_path, "r", encoding="utf-8") as f:
                text = f.read()
        else:
            text = download(url)
        count = 0
        for line in text.splitlines():
            parsed = parse_line(line.strip())
            if not parsed:
                continue
            word, defs = parsed
            if word not in dictionary:
                dictionary[word] = {"level": level, "defs": []}
                count += 1
            # 合并释义：同词性用"；"追加去重，不同词性新增条目（最多 MAX_DEFS 条）
            for pos, meaning in defs:
                entry = dictionary[word]
                same_pos = next((d for d in entry["defs"] if d["pos"] == pos), None)
                if same_pos:
                    for part in meaning.split("；"):
                        part = part.strip()
                        if part and part not in same_pos["meaning"]:
                            same_pos["meaning"] += "；" + part
                elif len(entry["defs"]) < MAX_DEFS:
                    entry["defs"].append({"pos": pos, "meaning": meaning})
        stats[level] = count

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    payload = json.dumps(dictionary, ensure_ascii=False, separators=(",", ":"))
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("// 四六级词库数据（由 tools/build_dict.py 生成，来源: github.com/KyleBing/english-vocabulary）\n")
        f.write("window.CET_DICT = ")
        f.write(payload)
        f.write(";\n")

    size_kb = os.path.getsize(OUT) / 1024
    print(f"完成: {stats}, 总计 {len(dictionary)} 词, 输出 {OUT} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
