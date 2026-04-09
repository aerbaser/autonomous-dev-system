from pathlib import Path

import jinja2

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"

_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(str(_PROMPTS_DIR)),
    autoescape=False,
    keep_trailing_newline=True,
    undefined=jinja2.StrictUndefined,
)


def load_template(name: str) -> jinja2.Template:
    """Load a Jinja2 template by filename from the prompts directory.

    Args:
        name: Template filename, e.g. "categorize.txt"

    Raises:
        FileNotFoundError: If the template file does not exist.
    """
    try:
        return _env.get_template(name)
    except jinja2.TemplateNotFound:
        raise FileNotFoundError(
            f"Prompt template '{name}' not found in {_PROMPTS_DIR}"
        )


def render_prompt(name: str, **kwargs: object) -> str:
    """Load and render a prompt template with the provided variables.

    Args:
        name: Template filename, e.g. "categorize.txt"
        **kwargs: Variables to substitute into the template.

    Returns:
        Rendered prompt string.

    Raises:
        FileNotFoundError: If the template file does not exist.
        jinja2.UndefinedError: If a required template variable is missing.
    """
    template = load_template(name)
    return template.render(**kwargs)
