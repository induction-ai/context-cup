import sys

from context_cup_protocol import run_engine

from . import LitellmContext, finish

sys.exit(run_engine(LitellmContext, "litellm", finish=finish))
