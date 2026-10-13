import sys

from context_cup_protocol import run_engine

from . import AisdkContext, finish

sys.exit(run_engine(AisdkContext, "aisdk_python", finish=finish))
