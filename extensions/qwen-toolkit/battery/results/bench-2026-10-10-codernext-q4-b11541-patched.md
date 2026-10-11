| model                          |       size |     params | backend    | ngl | n_batch | n_ubatch |  fa |            test |                  t/s |
| ------------------------------ | ---------: | ---------: | ---------- | --: | ------: | -------: | --: | --------------: | -------------------: |
| qwen3next 80B.A3B Q4_K - Medium |  46.20 GiB |    79.67 B | Vulkan     |  99 |    4096 |     1024 |   1 |           pp512 |        956.42 ± 3.23 |
| qwen3next 80B.A3B Q4_K - Medium |  46.20 GiB |    79.67 B | Vulkan     |  99 |    4096 |     1024 |   1 |          pp8192 |        886.50 ± 2.55 |
| qwen3next 80B.A3B Q4_K - Medium |  46.20 GiB |    79.67 B | Vulkan     |  99 |    4096 |     1024 |   1 |           tg128 |         45.00 ± 0.16 |
| qwen3next 80B.A3B Q4_K - Medium |  46.20 GiB |    79.67 B | Vulkan     |  99 |    4096 |     1024 |   1 |  pp512 @ d32768 |        336.38 ± 6.32 |
| qwen3next 80B.A3B Q4_K - Medium |  46.20 GiB |    79.67 B | Vulkan     |  99 |    4096 |     1024 |   1 | pp8192 @ d32768 |        343.87 ± 0.05 |
| qwen3next 80B.A3B Q4_K - Medium |  46.20 GiB |    79.67 B | Vulkan     |  99 |    4096 |     1024 |   1 |  tg128 @ d32768 |         35.80 ± 0.13 |

build: f2918cabb (11541)
