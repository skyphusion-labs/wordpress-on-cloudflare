"""Make one per-request CSV from a round's jsonl files (the 7-screen round, m504base.py).
  to-csv.py <out.csv> <run label> <file.jsonl>...
The last two columns (x_runtime_recycled, boot) were added for the b-dosql #566 rounds; older CSVs end at err_len.
Columns are names, numbers and statuses only: no cookie, no token, no address, no row data."""
import csv, json, sys, datetime
out, label, files = sys.argv[1], sys.argv[2], sys.argv[3:]
cols = ["run", "file", "t_utc", "round", "screen", "method", "status", "ms", "x_isolate_retry", "x_write_loss", "x_isolate_reset",
        "wasm1_mib", "saved_and_read_back", "hwp_cold", "hwp_phpMs", "hwp_queries", "hwp_dbMs", "hwp_wasmMB", "hwp_served", "hwp_fetches", "err_len",
        "x_runtime_recycled", "boot"]
n = 0
with open(out, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(cols)
    for path in files:
        name = path.split("/")[-1]
        for line in open(path):
            if not line.strip():
                continue
            r = json.loads(line)
            if r.get("ev") != "req":
                continue
            h = {}
            if r.get("hwp"):
                try:
                    h = json.loads(r["hwp"])
                except ValueError:
                    h = {}
            t = datetime.datetime.utcfromtimestamp(r["t"]).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
            code = r.get("code")
            w.writerow([label, name, t, r.get("round"), r.get("screen"), r.get("method", ""), code,
                        round(r["s"] * 1000) if isinstance(r.get("s"), (int, float)) else "",
                        r.get("x-isolate-retry", ""), r.get("x-write-loss", ""), r.get("x-isolate-reset", ""),
                        r.get("wasm1", "") if r.get("wasm1") is not None else "",
                        ("" if r.get("stuck") is None else ("1" if r.get("stuck") else "0")),
                        h.get("cold", ""), h.get("phpMs", ""), h.get("queries", ""), h.get("dbMs", ""), h.get("wasmMB", ""), h.get("served", ""), h.get("fetches", ""),
                        r.get("errLen", ""), r.get("x-runtime-recycled", ""), r.get("x-boot", "")])
            n += 1
print(out, n, "rows")
