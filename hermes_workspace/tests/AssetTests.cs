using System.IO.Compression;
using HermesChat;

static class AssetTests
{
    public static int Run()
    {
        int count=0;
        void Check(bool result,string label){if(!result)throw new Exception(label);count++;Console.WriteLine("PASS "+label);}
        var temp=Path.Combine(Path.GetTempPath(),"workspace-package-"+Guid.NewGuid());Directory.CreateDirectory(temp);
        var p=new Profile{Id="test-"+Guid.NewGuid().ToString("N"),Name="Test agent",SessionKey="not-portable",Prompt="Do the task"};
        var skill=new AgentAsset{Name="test-skill",Description="Test pipeline",Content="Run and validate the result.",RequiredEnv=new(){"SERVICE_API_KEY"},Files=new(){["references/check.md"]="Acceptance"}};
        var tool=new AgentAsset{Name="test-tool",Kind="tool",Description="Test operation",Content="print('ok')"};
        p.AssetIds.AddRange(new[]{skill.Id,tool.Id});p.TestCases.Add(new(){Status="passed",Result="Evidence",ThreadId="server-session",AssetVersions=new(){[skill.Id]=1}});
        try
        {
            AgentPackages.SaveEnv(p.Id,"SERVICE_API_KEY","TEST_SECRET_SENTINEL");
            var context=AgentPackages.Context(p,new[]{skill,tool});
            Check(context.Contains("Run and validate")&&!context.Contains("TEST_SECRET_SENTINEL"),"chat gets asset instructions without env values");
            var path=Path.Combine(temp,"agent.zip");AgentPackages.Export(path,p,new(){skill,tool},false,"# installer");
            using(var zip=ZipFile.OpenRead(path))
            {Check(zip.GetEntry(".env")==null&&zip.GetEntry(".env.example")!=null,"default export omits real secrets");Check(zip.Entries.Any(e=>e.FullName.EndsWith("scripts/run.py")),"tool exports runnable script");Check(zip.Entries.Any(e=>e.FullName.EndsWith("references/check.md")),"support files preserved");}
            var imported=AgentPackages.ReadBundle(path);
            Check(imported.Profile.Id!=p.Id&&imported.Profile.SessionKey==""&&imported.Profile.AssetIds.Count==2,"import creates independent profile with selected assets");
            Check(imported.Tests[0].Status=="imported"&&imported.Tests[0].ThreadId=="","imported tests are evidence, not live sessions");
            AgentPackages.Revision(skill,"new version","New description");Check(skill.Version==2&&skill.History[0].Content=="Run and validate the result.","revision preserves prior content");
            var secretPath=Path.Combine(temp,"private.zip");AgentPackages.Export(secretPath,p,new(){skill,tool},true,"# installer");using(var zip=ZipFile.OpenRead(secretPath))Check(zip.GetEntry(".env")!=null,"explicit secret export includes env");
            var malicious=Path.Combine(temp,"malicious.zip");using(var zip=ZipFile.Open(malicious,ZipArchiveMode.Create)){zip.CreateEntry("../escape");zip.CreateEntry("agent.json");}
            try{AgentPackages.ReadBundle(malicious);Check(false,"zip slip");}catch(InvalidDataException){Check(true,"path traversal rejected before import");}
            try{AgentPackages.SaveEnv(p.Id,"BAD\nNAME","value");Check(false,"env injection");}catch(InvalidDataException){Check(true,"env name injection rejected");}
            var bad=new AgentAsset{Name="bad",Description="Bad",Content="code",Files=new(){["../../escape"]="bad"}};try{AgentPackages.Validate(bad);Check(false,"support path");}catch(InvalidDataException){Check(true,"support-file traversal rejected");}
        }
        finally{Directory.Delete(temp,true);var envFolder=Path.GetDirectoryName(AgentPackages.EnvPath(p.Id))!;if(Directory.Exists(envFolder))Directory.Delete(envFolder,true);}
        return count;
    }
}
