import sys

from context_cup_protocol import run_engine

from . import PydanticContext, finish

sys.exit(run_engine(PydanticContext, "pydantic", finish=finish))
