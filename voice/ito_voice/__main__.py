import argparse
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(prog="ito-voice", description="Ito's voice loop on the GPU.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve", help="Run as ito-core's voice, over standard input and output.")
    checking = commands.add_parser("check", help="Load every model and measure this box.")
    checking.add_argument("--report", type=Path, default=Path("voice-check.md"))
    checking.add_argument("--details", type=Path, default=Path("voice-check-details.md"))
    arguments = parser.parse_args()
    if arguments.command == "serve":
        from ito_voice.serve import serve

        serve()
        return 0
    from ito_voice.check import check

    return check(arguments.report, arguments.details)


if __name__ == "__main__":
    sys.exit(main())
