// The Backlog (templates/backlog.html): every issue, open ones by priority unless the page's view says otherwise.
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { Bar } from "../frame/Bar";
import { FilterBar, Groups, Tools, type ListData } from "./parts";
import { useList } from "./useList";

export const BacklogPage = observer(function BacklogPage() {
  const { data } = useList<ListData>("/backlog", "/api/page/backlog", (d) => d.view);
  useEffect(() => { document.title = "Backlog · desk"; }, []);
  return (
    <>
      <Bar crumb={<span>Backlog</span>} tools={data && <Tools view={data.view} />} />
      <div className="scroll">
        {data && (
          <div className="page">
            <FilterBar list={data} />
            <Groups list={data} empty="Nothing in the backlog." />
          </div>
        )}
      </div>
    </>
  );
});
