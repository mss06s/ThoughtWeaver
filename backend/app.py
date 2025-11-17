import os, json, re
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

# --- setup ---
load_dotenv()  # Load environment variables from a .env file if present
app = Flask(__name__)  # Create the Flask application instance
CORS(app)  # Enable CORS so the frontend (different origin) can call this API

# --- system prompt ---
# System-level instructions that guide the LLM to output a structured, visualizable graph.
SYSTEM_PROMPT = """You are a thought-mapping AI that extracts clear, visually meaningful concepts.

Given messy human text, return STRICT JSON in the format:
{
  "nodes": [
    { "id": "string-slug", "label": "Readable Label", "category": "emotion|habit|goal|problem|solution" }
  ],
  "edges": [
    { "from": "node-id", "to": "node-id", "relation": "causes|improves|worsens|relates_to|influences", "weight": 0.4 }
  ],
  "insights": [
    "short human-readable insight sentences"
  ]
}

Rules:
- 5–10 nodes max.
- Create 1–2 central concepts connected to smaller related ideas.
- Keep relation words varied but short.
- Respond with JSON ONLY.
- Do NOT wrap in markdown or add ``` fences.
- No commentary outside JSON.
"""

# --- safe JSON extraction ---
def force_json(text: str):
    """
    Extract and normalize a JSON object from a raw LLM response.

    This function:
    - Handles accidental ```json / ``` fences.
    - Attempts to capture the last JSON-looking block in the response.
    - Cleans trailing commas before closing ']' or '}' to avoid parse errors.
    - Returns a Python object via json.loads.

    Raises:
        ValueError: If the input text is empty.
        json.JSONDecodeError: If the resulting candidate string is not valid JSON.
    """
    if not text:
        raise ValueError("empty model response")

    txt = text.strip()

    # Remove ```json fences if they exist
    if txt.startswith("```"):
        lines = txt.splitlines()
        lines = lines[1:]  # Drop first line 
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]  # Drop final ``` if present
        txt = "\n".join(lines).strip()

    # Grab the last {...} block, assuming that is the intended JSON.
    m = re.search(r"\{.*\}\s*$", txt, flags=re.S)
    candidate = m.group(0) if m else txt

    # Remove trailing commas before ']' or '}' to make the JSON parseable.
    candidate = re.sub(r",\s*([\]\}])", r"\1", candidate)

    return json.loads(candidate)

# --- model setup ---
# Provider is configurable via environment variable to allow swapping between Groq/OpenAI/mocked.
PROVIDER = os.getenv("PROVIDER", "groq").lower()
client = None

if PROVIDER == "groq":
    # Groq client configuration
    from groq import Groq
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    MODEL = "llama-3.1-8b-instant"
elif PROVIDER == "openai":
    # OpenAI client configuration
    from openai import OpenAI
    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    MODEL = "gpt-4o-mini"
else:
    # When no real model provider is configured, backend falls back to a mock implementation.
    MODEL = None  # mock mode


# --- API route ---
@app.post("/api/graph")
def graph():
    """
    Main API endpoint for generating a thought graph.

    Expects JSON payload:
        { "text": "<user freeform text>" }

    Behavior:
    - Validates that text is present.
    - If no real LLM client is configured, returns a deterministic mock graph for local testing.
    - Otherwise, sends the text plus SYSTEM_PROMPT to the configured provider.
    - Attempts to safely parse the model's response as JSON.
    - Returns a JSON structure with 'nodes', 'edges', and 'insights' or an error payload.
    """
    # Parse incoming JSON and normalize the input text
    payload = request.get_json(force=True)
    user_text = (payload.get("text") or "").strip()
    if not user_text:
        return jsonify({"error": "No text provided"}), 400

    # Mock mode for local development or when no provider is set.
    if client is None:
        # Simple heuristic: extract unique words as "nodes" to mimic a graph.
        words = [w.strip(",.!?").lower() for w in user_text.split()]
        uniq = list(dict.fromkeys([w for w in words if len(w) > 3]))[:8] or [
            "thoughts",
            "focus",
            "energy",
            "sleep",
        ]
        # Construct mock nodes using the unique words
        nodes = [{"id": w, "label": w.title()} for w in uniq]
        # Link consecutive words to form a basic path-like graph
        edges = [
            {
                "from": uniq[i],
                "to": uniq[i + 1],
                "relation": "related",
                "weight": 0.6,
            }
            for i in range(len(uniq) - 1)
        ]
        # Provide simple high-level insights based on extracted tokens
        insights = [
            f"Core topics: {', '.join(w.title() for w in uniq[:5])}.",
            "Try grouping related items and addressing one at a time.",
        ]
        return jsonify({"nodes": nodes, "edges": edges, "insights": insights})

    try:
        # --- ask the model ---
        if PROVIDER == "groq":
            # Call Groq chat completion API
            resp = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_text},
                ],
                temperature=0.3,
                max_tokens=700,
            )
            raw = resp.choices[0].message.content
        elif PROVIDER == "openai":
            # Call OpenAI chat completion API
            resp = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_text},
                ],
                temperature=0.3,
                max_tokens=700,
            )
            raw = resp.choices[0].message.content
        else:
            # Defensive fallback if provider configuration is inconsistent.
            return jsonify({"error": "No provider configured"}), 500

        # --- try to parse the JSON ---
        try:
            data = force_json(raw)
        except Exception as parse_err:
            return jsonify({
                "error": "Model returned invalid JSON. Please try again."
            }), 500


        # Successful result from model -> forward to client.
        return jsonify(data)

    except Exception as e:
        # Catch-all for provider/network/other runtime issues
        return jsonify({"error": f"AI backend error: {str(e)}"}), 429


# --- run app ---
if __name__ == "__main__":
    # Run the Flask development server
    app.run(host="0.0.0.0", port=5050)
