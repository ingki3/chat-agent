/**
 * `python_run` scenarios (#47) for the FakeRuntime and the tests: real calls of our MCP tool with fixed code.
 *
 * - `sum [<fileId>]`: the column sums of the given CSV (or of a small table made in the code) printed, and written to
 *   `합계.csv` — one registered output file;
 * - `loop`: an endless loop (the run's time limit stops it);
 * - `net`: an outbound connection attempt, printing whether it got through.
 */
export const PYTHON_SCENARIOS = ["sum", "loop", "net"] as const;
export type PythonScenario = (typeof PYTHON_SCENARIOS)[number];

const SUM = String.raw`
import pandas as pd
if FILES:
    df = pd.read_csv(next(iter(FILES.values())))
else:
    df = pd.DataFrame({"항목": ["숙박", "렌터카", "식비"], "금액": [480000, 210000, 356000]})
sums = df.select_dtypes("number").sum()
print("행", len(df))
for k, v in sums.items():
    print(k, int(v))
sums.to_frame("합계").to_csv("합계.csv")
`;

const LOOP = "while True:\n    pass\n";

const NET = String.raw`
import socket
try:
    socket.create_connection(("1.1.1.1", 443), timeout=3).close()
    print("network: OPEN")
except OSError as e:
    print("network: blocked", type(e).__name__)
`;

export function pythonScenario(
  name: PythonScenario,
  fileId?: string,
): { input: Record<string, unknown>; answer: string } {
  const code = name === "sum" ? SUM : name === "loop" ? LOOP : NET;
  return {
    input: { code, ...(fileId ? { files: [fileId] } : {}) },
    answer:
      name === "sum"
        ? "계산했어요. 합계 파일을 아래에서 내려받을 수 있어요."
        : name === "loop"
          ? "코드가 시간 안에 끝나지 않았어요."
          : "네트워크 접속을 시도해 봤어요.",
  };
}
