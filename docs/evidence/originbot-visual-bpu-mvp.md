# OriginBot visual-to-twist BPU MVP evidence

This run proves the minimum artifact path on the current OriginBot/X5 setup:

1. The RTX 5090 trainer generated 4,096 synthetic detection-feature samples and trained `originbot-visual-twist-v1` on CUDA.
2. HBDK `3.49.15` (`hb_mapper 1.24.3`, `march=bayes-e`) compiled the ONNX graph to a 264,347-byte X5 `model.bin`.
3. The artifact was copied to X5 and loaded with `hobot_dnn.pyeasy_dnn`; a `[1,8,1,1] -> [1,2,1,1]` forward pass returned `[0.00310048, 0.04964658]`.
4. The SHA-256 is `b771bee619e1af08309369064717c469266094766f61307eb5bb162f0601456e`.

The policy is deliberately marked `synthetic`, `mock`, and `deployable=false`. Its 8D input is a synthetic detection-feature contract, not raw camera pixels. The existing platform board-policy runtime still accepts ONNX through `onnxruntime`; native `.bin` loading is currently an evidence path, not a physical-policy release path. No drive command was sent to the robot.

The machine-readable record is [`originbot-visual-bpu-mvp.json`](originbot-visual-bpu-mvp.json).
