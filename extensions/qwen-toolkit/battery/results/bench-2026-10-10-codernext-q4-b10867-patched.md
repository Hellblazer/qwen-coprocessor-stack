| model                          |       size |     params | backend    | ngl | n_batch | n_ubatch |  fa |            test |                  t/s |
| ------------------------------ | ---------: | ---------: | ---------- | --: | ------: | -------: | --: | --------------: | -------------------: |
| qwen3next 80B.A3B Q4_K - Medium |  46.20 GiB |    79.67 B | Vulkan     |  99 |    4096 |     1024 |   1 |           pp512 |        655.76 ± 5.21 |
| qwen3next 80B.A3B Q4_K - Medium |  46.20 GiB |    79.67 B | Vulkan     |  99 |    4096 |     1024 |   1 |          pp8192 |        644.70 ± 0.54 |
| qwen3next 80B.A3B Q4_K - Medium |  46.20 GiB |    79.67 B | Vulkan     |  99 |    4096 |     1024 |   1 |           tg128 |         45.78 ± 0.25 |
| qwen3next 80B.A3B Q4_K - Medium |  46.20 GiB |    79.67 B | Vulkan     |  99 |    4096 |     1024 |   1 |  pp512 @ d32768 |        290.42 ± 1.40 |
| qwen3next 80B.A3B Q4_K - Medium |  46.20 GiB |    79.67 B | Vulkan     |  99 |    4096 |     1024 |   1 | pp8192 @ d32768 |        298.51 ± 0.49 |
| qwen3next 80B.A3B Q4_K - Medium |  46.20 GiB |    79.67 B | Vulkan     |  99 |    4096 |     1024 |   1 |  tg128 @ d32768 |         36.23 ± 0.08 |

build: f3f1a8f27 (10867)
