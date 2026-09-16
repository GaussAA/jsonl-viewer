"""Generate moderate & large JSONL samples for testing the JSONL Viewer.
Only uses stdlib. Run:  uv run python samples/generate_samples.py
"""
import json
import random

OUT_DIR = "samples"
random.seed(42)

CITIES = ["Shanghai", "Beijing", "Shenzhen", "Hangzhou", "Chengdu", "Wuhan",
          "Guangzhou", "Nanjing", "Xian", "Chongqing"]
STATUS = ["active", "inactive", "pending"]
CATEGORIES = ["alpha", "beta", "gamma", "delta"]
TOPICS = ["login", "checkout", "search", "profile", "billing", "support", "report"]
TAGS = ["urgent", "gift", "vip", "repeat", "new", "priority", "bulk", "test"]


def record(i):
    return {
        "id": i,
        "user": f"user_{i % 500:03d}",
        "status": random.choice(STATUS),
        "category": random.choice(CATEGORIES),
        "city": random.choice(CITIES),
        "amount": round(random.uniform(-50.0, 999.99), 2),
        "created": f"2024-0{random.randint(1, 9)}-{random.randint(1, 28):02d}T{random.randint(0, 23):02d}:{random.randint(0, 59):02d}:00Z",
        "tags": [random.choice(TAGS) for _ in range(random.randint(0, 4))],
        "meta": {
            "topic": random.choice(TOPICS),
            "attempts": random.randint(1, 8),
            "satisfied": random.choice([True, False, None]),
        },
    }


def write(name, how_many):
    path = f"{OUT_DIR}/{name}"
    with open(path, "w", encoding="utf-8") as f:
        for i in range(how_many):
            f.write(json.dumps(record(i), ensure_ascii=False) + "\n")
    print(f"wrote {how_many} lines -> {path}")


write("07_search_filter.jsonl", 200)
write("08_large_1k.jsonl", 1_000)
write("09_large_10k.jsonl", 10_000)
write("10_large_100k.jsonl", 100_000)