import sys

from context_cup_protocol import run_engine

from .engine import PythonContext

sys.exit(run_engine(PythonContext, "python"))
