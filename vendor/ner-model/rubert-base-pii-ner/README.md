---
license: apache-2.0
language:
- ru
base_model: ai-forever/ruBert-base
base_model_relation: finetune
pipeline_tag: token-classification
library_name: transformers
datasets:
- redmadrobot-rnd/pii_train
- redmadrobot-rnd/pii_benchmark
tags:
- pii
- ner
- named-entity-recognition
- pii-detection
- privacy
- anonymization
- guardrails
- russian
model-index:
- name: redmadrobot-rnd/rubert-base-pii-ner
  results:
  - task:
      type: token-classification
      name: Token Classification
    dataset:
      name: Russian PII NER Benchmark
      type: redmadrobot-rnd/pii_benchmark
      split: test
    metrics:
    - name: Precision (14 categories, exact match)
      type: precision
      value: 0.819
    - name: Recall (14 categories, exact match)
      type: recall
      value: 0.855
    - name: F1 (14 categories, exact match)
      type: f1
      value: 0.836
    - name: F1 (PERSON + LOCATION, overlap match — leaderboard protocol)
      type: f1
      value: 0.947
---

# Russian PII NER Model

Token-classification model that finds **personal data** (names, addresses,
contacts) and **Russian identity-document numbers** (passport, SNILS, INN, OMS,
driver licence, military ID, birth certificate, bank card) in Russian text.
It is the NER component of the `pii-guard` anonymization pipeline.

Fine-tuned from `ai-forever/ruBert-base` on 17,137 annotated Russian sentences,
with a **21-type / 43-label BIO** head.

## Model Sources

- **Training data:** [redmadrobot-rnd/pii_train](https://huggingface.co/datasets/redmadrobot-rnd/pii_train) — 17,137 sentences, 39,687 entity spans
- **Evaluation data:** [redmadrobot-rnd/pii_benchmark](https://huggingface.co/datasets/redmadrobot-rnd/pii_benchmark) — 2,841 held-out sentences, disjoint from the training data
- **Code:** [github.com/redmadrobot-rnd/pii-guard](https://github.com/redmadrobot-rnd/pii-guard)

## Entity Types

**1. Person (names)**
`FIRST_NAME`, `LAST_NAME`, `MIDDLE_NAME` — given name, surname, and patronymic,
including mixed-case, latin-script, and out-of-order spellings.

**2. Location / Address**
`COUNTRY`, `REGION`, `DISTRICT`, `CITY`, `STREET`, `HOUSE` — the full Russian
address hierarchy down to the house/building number.

**3. Contacts**
`EMAIL`, `PHONE`, `URL`, `IP_ADDRESS` — structured contact and network
identifiers in many real-world formats.

**4. Russian identity-document numbers**
`PASSPORT`, `INN` (taxpayer number), `SNILS` (insurance account), `OMS`
(medical insurance policy), `CREDIT_CARD`, `DRIVER_LICENSE`,
`MILITARY_ID`, `BIRTH_CERTIFICATE` — document numbers in their canonical and
noisy/typo'd forms.

Labels follow the BIO scheme: `B-<TYPE>` / `I-<TYPE>` plus `O` — 43 labels total.

## Usage

```python
from transformers import pipeline

ner = pipeline(
    "token-classification",
    model="redmadrobot-rnd/rubert-base-pii-ner",
    aggregation_strategy="simple",
)

text = "Иванов Пётр Сергеевич, паспорт 45 11 123456, тел. +7 999 123-45-67"
for ent in ner(text):
    print(f"{ent['entity_group']:16s} {ent['word']!r} {ent['score']:.2f}")
```

Windowing over long inputs, confidence filtering and **merging adjacent
fragments of the same entity** are the caller's responsibility. The `pii-guard`
pipeline uses `max_length=512`, a sliding window with `stride=128`, and drops
predictions below `min_confidence=0.3`.

Merging is not optional: `aggregation_strategy="simple"` leaves `elena@pochta.ru`
as `el` + `ena@pochta.ru` when the model re-emits `B-` mid-entity. All scores
below assume merged fragments.

## Evaluation

[redmadrobot-rnd/pii_benchmark](https://huggingface.co/datasets/redmadrobot-rnd/pii_benchmark),
2,841 held-out sentences. Span-level micro-F1, one-to-one greedy matching, gold
spans not normalised.

**Table 1. 14 categories both systems express** — exact matching. Folded: the
pipeline emits `PERSON` where the model emits `FIRST_NAME`. The pipeline also
covers `DATE_TIME`, `BANK_ACCOUNT`, `BIK` and `TELEGRAM`, which this model has no
head for.

| System | P | R | F1 |
|--------|--:|--:|---:|
| This model alone | 81.9 | 85.5 | 83.6 |
| `pii-guard` pipeline (rules + this model) | 90.4 | 87.5 | **88.9** |

On the benchmark's own leaderboard protocol — `PERSON` + `LOCATION`, overlap
matching — this model scores 94.7 F1, the pipeline 95.0.

**Table 2. Per-entity F1, this model alone** — exact matching.

| Entity | gold | F1 | Entity | gold | F1 |
|--------|-----:|---:|--------|-----:|---:|
| FIRST_NAME | 499 | 89.8 | IP_ADDRESS | 155 | 36.0 |
| LAST_NAME | 457 | 84.5 | PASSPORT | 494 | 81.3 |
| MIDDLE_NAME | 308 | 91.5 | INN | 263 | 68.3 |
| COUNTRY | 242 | 86.1 | SNILS | 223 | 78.5 |
| REGION | 176 | 80.3 | OMS | 170 | 90.1 |
| CITY | 339 | 82.5 | CREDIT_CARD | 203 | 87.9 |
| DISTRICT | 161 | 78.3 | DRIVER_LICENSE | 371 | 81.8 |
| STREET | 171 | 87.3 | MILITARY_ID | 278 | 78.3 |
| HOUSE | 163 | 92.7 | BIRTH_CERTIFICATE | 341 | 83.7 |
| EMAIL | 221 | 97.6 | | | |
| PHONE | 173 | 86.9 | | | |
| URL | 206 | 89.7 | | | |

`IP_ADDRESS` is the one weak spot — the model splits on the dots; in `pii-guard`
this type is a regex rule.

## Training Data

[redmadrobot-rnd/pii_train](https://huggingface.co/datasets/redmadrobot-rnd/pii_train)
— 17,137 Russian sentences with 39,687 BIO-annotated entity
spans: manually verified production logs (pseudonymized), synthetic
document-style texts per Russian document type, and hard negatives (numeric
strings that resemble document identifiers but are not). Rows that also occur in
`pii_benchmark` were removed from training, so evaluation stays clean.

Fine-tuned for 10 epochs, lr 3e-5 (linear decay, no warmup), batch size 16,
AdamW (weight decay 0.01), fp32, max sequence length 512, seed 42.

## Citation

If you use this model, please cite this repository.

**BibTeX:**

```bibtex
@misc{redmadrobot_rubert_base_pii_ner,
  title        = {Russian PII NER Model},
  author       = {Red Mad Robot R\&D},
  year         = {2026},
  howpublished = {\url{https://huggingface.co/redmadrobot-rnd/rubert-base-pii-ner}},
  note         = {Fine-tuned from ai-forever/ruBert-base}
}
```
