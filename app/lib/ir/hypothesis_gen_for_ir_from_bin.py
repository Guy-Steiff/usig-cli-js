# hypothesis_gen_for_ir_from_bin.py

import json
import struct
import math
import sys
from pathlib import Path


USIG_MAGIC_HINTS = [
    b'"waveformLength"',
    b'"waveformEncoding"',
    b'"schemaVersion"',
    b'USIG'
]


# ------------------------------------------------------------
# IO
# ------------------------------------------------------------

def read_file(path):
    return Path(path).read_bytes()


def safe_decode_ascii(data):
    return data.decode("utf-8", errors="ignore")


# ------------------------------------------------------------
# USIG detection
# ------------------------------------------------------------

def detect_usig_ir(data):

    text = safe_decode_ascii(data[:4096])

    hits = sum(
        1
        for x in USIG_MAGIC_HINTS
        if x.decode(errors="ignore") in text
    )

    return hits >= 2, (1.0 if hits >= 2 else 0)


# ------------------------------------------------------------
# JSON extraction
# ------------------------------------------------------------

def extract_json_region(data):

    tokens = [
        b'{"headers"',
        b'{"schemaVersion"',
        b'{"metadata"',
        b'{"waveformLength"',
        b'{"cacheKey"'
    ]

    starts = []

    for token in tokens:
        pos = data.find(token)
        if pos >= 0:
            starts.append(pos)

    for start in sorted(starts):

        depth = 0
        in_string = False
        escape = False

        for i in range(start, len(data)):

            c = data[i]

            if in_string:

                if escape:
                    escape = False

                elif c == 92:
                    escape = True

                elif c == 34:
                    in_string = False

            else:

                if c == 34:
                    in_string = True

                elif c == 123:
                    depth += 1

                elif c == 125:

                    depth -= 1

                    if depth == 0:

                        blob = data[start:i+1]

                        try:
                            return json.loads(
                                blob.decode("utf-8")
                            )

                        except Exception:
                            break

    return None



def flatten_json(obj, prefix=""):

    out = []

    if isinstance(obj, dict):

        for k, v in obj.items():

            path = (
                f"{prefix}.{k}"
                if prefix
                else k
            )

            if isinstance(v, (dict, list)):
                out.extend(
                    flatten_json(v, path)
                )

            else:

                out.append({
                    "path": path,
                    "value": v,
                    "source": "embedded_json"
                })

    return out



# ------------------------------------------------------------
# waveform definition normalization
# ------------------------------------------------------------

def normalize_encoding(value):

    if not value:
        return None

    v = str(value).lower()

    if "float32" in v:
        return "float32"

    if "int16" in v:
        return "int16"

    return v



def build_waveform_definition(
        fields,
        reconstruction=None,
        candidate=None):

    wf = {}

    # --------------------------------------------------------
    # explicit fields first
    # --------------------------------------------------------

    lookup = {}

    for f in fields:

        lookup[f["path"].lower()] = f["value"]


    def find(names):

        for k, v in lookup.items():

            for name in names:

                if k.endswith(name.lower()):
                    return v

        return None


    wf["encoding"] = normalize_encoding(
        find([
            "waveformencoding",
            "waveformtype",
            "encoding"
        ])
    )


    wf["endianness"] = find([
        "endianness"
    ])


    wf["bytes_per_sample"] = find([
        "waveformbytesperelement",
        "bytespersample"
    ])


    wf["samples"] = find([
        "waveformlength",
        "samples"
    ])


    wf["offset"] = 0


    wf["scale"] = find([
        "scale"
    ])


    wf["offset_value"] = find([
        "offset_value"
    ])


    # --------------------------------------------------------
    # reconstruction fallback
    # --------------------------------------------------------

    if reconstruction:

        if wf["encoding"] is None:
            wf["encoding"] = normalize_encoding(
                reconstruction.get("encoding")
            )

        if wf["samples"] is None:
            wf["samples"] = reconstruction.get(
                "length"
            )

        if wf["bytes_per_sample"] is None:

            bl = reconstruction.get(
                "byte_length"
            )

            ln = reconstruction.get(
                "length"
            )

            if bl and ln:
                wf["bytes_per_sample"] = (
                    bl // ln
                )


    # --------------------------------------------------------
    # heuristic fallback
    # --------------------------------------------------------

    if candidate:

        for k in [
            "encoding",
            "endianness"
        ]:

            if wf.get(k) is None:
                wf[k] = candidate.get(k)


        if wf["samples"] is None:
            wf["samples"] = candidate.get(
                "length"
            )

        if wf["offset"] == 0:
            wf["offset"] = candidate.get(
                "offset",
                0
            )


    # --------------------------------------------------------
    # defaults
    # --------------------------------------------------------

    if wf["encoding"] is None:
        wf["encoding"] = "float32"


    if wf["endianness"] is None:
        wf["endianness"] = "little"


    if wf["bytes_per_sample"] is None:

        if wf["encoding"] == "float32":
            wf["bytes_per_sample"] = 4

        elif wf["encoding"] == "int16":
            wf["bytes_per_sample"] = 2


    if wf["scale"] is None:
        wf["scale"] = 1.0


    if wf["offset_value"] is None:
        wf["offset_value"] = 0.0


    return wf



# ------------------------------------------------------------
# USIG parser
# ------------------------------------------------------------

def parse_usig(data):

    meta = extract_json_region(data)

    result = {
        "container": {
            "type": "USIG_IR",
            "confidence": 1.0
        },
        "metadata_fields": [],
        "reconstruction": {}
    }


    if not meta:

        result["container"]["confidence"] = 0.5
        return result


    fields = flatten_json(meta)

    result["metadata_fields"] = fields


    length = None
    byte_length = None
    encoding = None


    for f in fields:

        p = f["path"]

        if p.endswith("waveformLength"):
            length = f["value"]

        if p.endswith("waveformByteLength"):
            byte_length = f["value"]

        if p.endswith("waveformEncoding"):
            encoding = f["value"]


    if length and byte_length:

        result["reconstruction"] = {
            "length": length,
            "byte_length": byte_length,
            "encoding": encoding or "Float32Array"
        }


    return result



# ------------------------------------------------------------
# heuristic detector
# ------------------------------------------------------------

def float_stats(data, offset):

    values = []

    count = (
        len(data)-offset
    ) // 4


    if count < 64:
        return None


    for i in range(count):

        try:

            v = struct.unpack_from(
                "<f",
                data,
                offset+i*4
            )[0]

            if math.isfinite(v):
                values.append(v)

        except:
            break


    if len(values)<64:
        return None


    mn=min(values)
    mx=max(values)
    mean=sum(values)/len(values)


    if abs(mx)>1e10 or abs(mn)>1e10:
        return None


    return {
        "count":len(values),
        "min":mn,
        "max":mx,
        "mean":mean
    }



def find_waveform_candidate(data):

    best=None


    for offset in range(
        0,
        min(len(data),8192),
        4
    ):

        stats=float_stats(
            data,
            offset
        )

        if not stats:
            continue


        confidence=0.5


        if (
            stats["min"]>-10 and
            stats["max"]<10
        ):
            confidence+=0.4


        if abs(stats["mean"])<1:
            confidence+=0.099


        candidate={
            "name":"waveform",
            "offset":offset,
            "encoding":"float32",
            "endianness":"little",
            "length":stats["count"],
            "statistics":stats,
            "confidence":round(
                min(confidence,0.999),
                3
            )
        }


        if (
            best is None or
            candidate["confidence"] >
            best["confidence"]
        ):
            best=candidate


    return best



# ------------------------------------------------------------
# main generator
# ------------------------------------------------------------

def generate_hypothesis(filename):

    data=read_file(filename)


    result={
        "file":Path(filename).name,
        "size_bytes":len(data),
        "container":{},
        "metadata_fields":[],
        "reconstruction_fields":{},
        "arrays":[]
    }


    is_usig,_=detect_usig_ir(data)


    if is_usig:

        parsed=parse_usig(data)

        result.update(parsed)

        result["waveform_definition"] = (
            build_waveform_definition(
                result["metadata_fields"],
                result.get("reconstruction")
            )
        )


        result["decision"]={
            "can_create_ir":True,
            "mode":"direct_waveform"
        }

        return result



    result["container"]={
        "type":"unknown_binary",
        "confidence":0
    }


    candidate=find_waveform_candidate(data)


    if candidate:

        result["arrays"]=[
            candidate
        ]

        result["waveform_definition"]=(
            build_waveform_definition(
                [],
                candidate=candidate
            )
        )

        result["decision"]={
            "can_create_ir":True,
            "mode":"heuristic_waveform"
        }


    else:

        result["decision"]={
            "can_create_ir":False,
            "mode":"unknown"
        }


    return result



# ------------------------------------------------------------
# CLI
# ------------------------------------------------------------

if __name__=="__main__":
    for str_input_bin_file_path in ["/media/gnew/Mech/results/usig_unitesting/wavebin_examples/single.bin",
                                    r"/media/gnew/Mech/results/usig_unitesting/cannon_conversion_files/sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_woverrides.bin"]:
        input_path = str_input_bin_file_path

        if not input_path:
            print("No input file provided")
            raise SystemExit(1)

        try:
            output = generate_hypothesis(input_path)

            print(
                json.dumps(
                    output,
                    indent=2
                )
            )

        except FileNotFoundError:
            print(
                f"File not found: {input_path}"
            )
            raise SystemExit(1)

        except Exception as e:
            print(
                f"Processing failed: {e}"
            )
            raise